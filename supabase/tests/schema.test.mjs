// Runs every migration against PGlite (in-process Postgres) with a minimal
// stand-in for Supabase's auth schema, then checks diet tagging and RLS.
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { before, describe, it } from 'node:test'

const migrationsDir = new URL('../migrations/', import.meta.url)

const ALICE = '00000000-0000-0000-0000-00000000000a'
const BOB = '00000000-0000-0000-0000-00000000000b'

const stubDir = new URL('./', import.meta.url)
const SUPABASE_STUB = await readFile(
  new URL('supabase_stub.sql', stubDir),
  'utf8',
)
const GRANTS = await readFile(new URL('grants.sql', stubDir), 'utf8')

let db

/** Run fn as a Supabase role (and user, for authenticated), then reset. */
async function as(role, userId, fn) {
  await db.exec(`set role ${role}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [
    userId ?? '',
  ])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

// Seeded ingredients (e.g. soy sauce) are reused, with the test's categories.
async function ingredient(name, contains = []) {
  const { rows } = await db.query(
    `insert into ingredients (name, contains) values ($1, $2)
     on conflict ((lower(name))) do update set contains = excluded.contains
     returning id`,
    [name, contains],
  )
  return rows[0].id
}

async function recipe(title, lines, extra = {}) {
  const { rows } = await db.query(
    `insert into recipes (title, source_url, status, visibility, added_by)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      title,
      extra.url ?? `https://example.com/${encodeURIComponent(title)}`,
      extra.status ?? 'active',
      extra.visibility ?? 'public',
      extra.addedBy ?? null,
    ],
  )
  const id = rows[0].id
  for (const [lineNo, options] of lines.entries()) {
    for (const [i, ingredientId] of options.entries()) {
      await db.query(
        `insert into recipe_ingredients (recipe_id, line_no, option_no, raw_text, ingredient_id)
         values ($1, $2, $3, 'line', $4)`,
        [id, lineNo, i + 1, ingredientId],
      )
    }
  }
  return id
}

async function meetsDiet(recipeId, diet) {
  const { rows } = await db.query('select recipe_meets_diet($1, $2) as ok', [
    recipeId,
    diet,
  ])
  return rows[0].ok
}

before(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    await db.exec(await readFile(new URL(file, migrationsDir), 'utf8'))
  }
  await db.exec(GRANTS)
  await db.exec(`insert into auth.users (id) values ('${ALICE}'), ('${BOB}')`)
})

describe('reference data', () => {
  it('seeds diets, cuisines and store chains', async () => {
    const { rows } = await db.query(`
      select (select count(*) from diets)::int as diets,
             (select count(*) from cuisines)::int as cuisines,
             (select price_source from store_chains where slug = 'harris_teeter') as ht
    `)
    assert.ok(rows[0].diets >= 5)
    assert.ok(rows[0].cuisines >= 20)
    assert.equal(rows[0].ht, 'kroger_api')
  })

  it('seeds one baseline price per priced staple', async () => {
    // Ingredients added later (apps/api/data/ingredients.csv) have no baseline price yet.
    const { rows } = await db.query(`
      select (select count(*) from prices where source in ('baseline_bls', 'baseline_usda', 'seed'))::int as prices,
             (select count(distinct ingredient_id) from prices
                where source in ('baseline_bls', 'baseline_usda', 'seed'))::int as priced
    `)
    assert.ok(rows[0].prices >= 100)
    assert.equal(rows[0].prices, rows[0].priced)
  })

  it('rejects unknown ingredient categories', async () => {
    await assert.rejects(ingredient('mystery', ['plutonium']))
  })
})

describe('recipe_meets_diet', () => {
  let tofu, rice, fishSauce, soySauce, chickenStock, unmapped

  before(async () => {
    tofu = await ingredient('tofu', ['soy'])
    rice = await ingredient('rice')
    fishSauce = await ingredient('fish sauce', ['fish'])
    soySauce = await ingredient('soy sauce', ['soy', 'gluten'])
    chickenStock = await ingredient('chicken stock', ['poultry'])
    unmapped = null
  })

  it('accepts a recipe when every line has a fitting option', async () => {
    // "2 tbsp fish sauce (or soy sauce)" is one line with two options.
    const id = await recipe('Tofu stir fry', [
      [tofu],
      [rice],
      [fishSauce, soySauce],
    ])
    assert.equal(await meetsDiet(id, 'vegetarian'), true)
    assert.equal(await meetsDiet(id, 'vegan'), true)
    assert.equal(await meetsDiet(id, 'gluten_free'), true) // fish sauce option is gluten-free
  })

  it('rejects a recipe with a required line that breaks the diet', async () => {
    const id = await recipe('Chicken soup', [[chickenStock], [rice]])
    assert.equal(await meetsDiet(id, 'vegetarian'), false)
    assert.equal(await meetsDiet(id, 'pescatarian'), false)
  })

  it("returns null when it can't tell (unmapped ingredient)", async () => {
    const id = await recipe('Mystery bowl', [[rice], [unmapped]])
    assert.equal(await meetsDiet(id, 'vegetarian'), null)
  })

  it('prefers false over unknown', async () => {
    const id = await recipe('Mixed', [[chickenStock], [unmapped]])
    assert.equal(await meetsDiet(id, 'vegetarian'), false)
  })

  it('ignores optional lines', async () => {
    const id = await recipe('Rice with optional chicken', [[rice]])
    await db.query(
      `insert into recipe_ingredients (recipe_id, line_no, raw_text, ingredient_id, is_optional)
       values ($1, 9, 'chicken stock (optional)', $2, true)`,
      [id, chickenStock],
    )
    assert.equal(await meetsDiet(id, 'vegetarian'), true)
  })
})

describe('row level security', () => {
  let publicRecipe, privateRecipe, draftRecipe

  before(async () => {
    const rice = await ingredient('jasmine rice')
    publicRecipe = await recipe('Public', [[rice]])
    privateRecipe = await recipe('Alice private', [[rice]], {
      visibility: 'private',
      addedBy: ALICE,
    })
    draftRecipe = await recipe('Draft', [[rice]], { status: 'needs_review' })
  })

  it('shows anonymous users only public, active recipes', async () => {
    const ids = await as('anon', null, async () =>
      (await db.query('select id from recipes')).rows.map((r) => r.id),
    )
    assert.ok(ids.includes(publicRecipe))
    assert.ok(!ids.includes(privateRecipe))
    assert.ok(!ids.includes(draftRecipe))
  })

  it("hides a private recipe's ingredients from other users", async () => {
    const count = (userId) =>
      as('authenticated', userId, async () => {
        const { rows } = await db.query(
          'select count(*)::int as n from recipe_ingredients where recipe_id = $1',
          [privateRecipe],
        )
        return rows[0].n
      })
    assert.equal(await count(ALICE), 1)
    assert.equal(await count(BOB), 0)
  })

  it('keeps meal plans and their entries private', async () => {
    await as('authenticated', ALICE, async () => {
      const { rows } = await db.query(
        `insert into meal_plans (user_id, week_start) values ($1, '2026-10-05') returning id`,
        [ALICE],
      )
      await db.query(
        'insert into meal_plan_entries (meal_plan_id, recipe_id, scale) values ($1, $2, 2)',
        [rows[0].id, publicRecipe],
      )
    })
    const bobSees = await as('authenticated', BOB, async () => {
      const plans = await db.query('select count(*)::int as n from meal_plans')
      const entries = await db.query(
        'select count(*)::int as n from meal_plan_entries',
      )
      return plans.rows[0].n + entries.rows[0].n
    })
    assert.equal(bobSees, 0)
  })

  it("won't let a user create rows for someone else", async () => {
    await assert.rejects(
      as('authenticated', BOB, () =>
        db.query(
          `insert into meal_plans (user_id, week_start) values ($1, '2026-10-12')`,
          [ALICE],
        ),
      ),
    )
  })

  it('lets users add private prices but not store prices', async () => {
    const { rows } = await db.query(
      `select id from ingredients where name = 'tofu'`,
    )
    const tofu = rows[0].id
    await as('authenticated', ALICE, () =>
      db.query(
        `insert into prices (source, ingredient_id, user_id, price_cents, quantity, unit)
         values ('user', $1, $2, 249, 14, 'oz')`,
        [tofu, ALICE],
      ),
    )
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query(
          `insert into prices (source, ingredient_id, price_cents, quantity, unit)
           values ('store_api', $1, 199, 14, 'oz')`,
          [tofu],
        ),
      ),
    )
    const bobSees = await as('authenticated', BOB, async () => {
      const r = await db.query(
        'select count(*)::int as n from prices where user_id is not null',
      )
      return r.rows[0].n
    })
    assert.equal(bobSees, 0)
  })
})

describe('diet customization', () => {
  const CAROL = '00000000-0000-0000-0000-00000000000c'
  const ids = {}
  let parmesanPasta, tacos, tacosEitherTortilla, pestoPasta, baconPasta

  const idOf = async (name) =>
    (
      await db.query('select id from ingredients where lower(name) = $1', [
        name,
      ])
    ).rows[0].id
  const fit = async (recipeId, userId) =>
    (
      await db.query('select recipe_fit_for_user($1, $2) as s', [
        recipeId,
        userId,
      ])
    ).rows[0].s
  const setProfile = (fields) =>
    db.query(
      `insert into profiles (user_id, avoid_categories, allergens, strict_may_contain)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update set avoid_categories = excluded.avoid_categories,
         allergens = excluded.allergens, strict_may_contain = excluded.strict_may_contain`,
      [
        CAROL,
        fields.avoid ?? [],
        fields.allergens ?? [],
        fields.strict ?? false,
      ],
    )

  before(async () => {
    await db.query('insert into auth.users (id) values ($1)', [CAROL])
    await db.query(
      `insert into user_diets (user_id, diet_slug) values ($1, 'vegetarian')`,
      [CAROL],
    )
    for (const name of [
      'pasta',
      'parmesan',
      'flour tortillas',
      'corn tortillas',
      'canned black beans',
      'bacon',
    ]) {
      ids[name] = await idOf(name)
    }
    const { rows } = await db.query(
      `insert into ingredients (name, contains, may_contain) values ('test pesto', '{dairy}', '{tree_nut}')
       returning id`,
    )
    ids.pesto = rows[0].id
    parmesanPasta = await recipe('Cacio e pepe', [[ids.pasta], [ids.parmesan]])
    tacos = await recipe('Bean tacos', [
      [ids['flour tortillas']],
      [ids['canned black beans']],
    ])
    tacosEitherTortilla = await recipe('Bean tacos (any tortilla)', [
      [ids['flour tortillas'], ids['corn tortillas']],
      [ids['canned black beans']],
    ])
    pestoPasta = await recipe('Pesto pasta', [[ids.pasta], [ids.pesto]])
    baconPasta = await recipe('Carbonara', [[ids.pasta], [ids.bacon]])
  })

  it('keeps "may contain" out of recipe diet labels', async () => {
    // Parmesan is fine for plain vegetarian; rennet isn't part of that preset.
    assert.equal(await meetsDiet(parmesanPasta, 'vegetarian'), true)
    // Flour tortillas may contain lard, so the label isn't earned outright.
    assert.equal(await meetsDiet(tacos, 'vegetarian'), null)
    assert.equal(await meetsDiet(tacosEitherTortilla, 'vegetarian'), true)
  })

  it('flags may-contain ingredients for a check by default', async () => {
    await setProfile({})
    assert.equal(await fit(parmesanPasta, CAROL), 'fits')
    assert.equal(await fit(tacos, CAROL), 'check_label')
    assert.equal(await fit(tacosEitherTortilla, CAROL), 'fits')
  })

  it('adds extra exclusions on top of a preset', async () => {
    await setProfile({ avoid: ['animal_rennet'] })
    assert.equal(await fit(parmesanPasta, CAROL), 'check_label')
    await setProfile({ avoid: ['animal_rennet'], strict: true })
    assert.equal(await fit(parmesanPasta, CAROL), 'excluded')
    assert.equal(await fit(tacos, CAROL), 'excluded')
  })

  it('treats allergies as strict regardless of the setting', async () => {
    await setProfile({ allergens: ['tree_nut'], strict: false })
    assert.equal(await fit(pestoPasta, CAROL), 'excluded')
  })

  it('supports narrower presets like no pork', async () => {
    assert.equal(await meetsDiet(baconPasta, 'no_pork'), false)
    assert.equal(await meetsDiet(baconPasta, 'no_red_meat'), false)
    assert.equal(await meetsDiet(parmesanPasta, 'no_pork'), true)
  })

  it('stores soft goals as either specific days or a weekly count', async () => {
    // Meatless Mondays, and four vegetarian dinners a week.
    await db.query(
      `insert into user_diet_goals (user_id, diet_slug, days, meal) values ($1, 'vegetarian', '{1}', 'dinner')`,
      [CAROL],
    )
    await db.query(
      `insert into user_diet_goals (user_id, diet_slug, per_week, meal) values ($1, 'vegetarian', 4, 'dinner')`,
      [CAROL],
    )
    for (const bad of [
      `insert into user_diet_goals (user_id, diet_slug, days, per_week) values ($1, 'vegetarian', '{1}', 2)`,
      `insert into user_diet_goals (user_id, diet_slug) values ($1, 'vegetarian')`,
      `insert into user_diet_goals (user_id, diet_slug, days) values ($1, 'vegetarian', '{8}')`,
    ]) {
      await assert.rejects(db.query(bad, [CAROL]))
    }
  })

  it('stores weights between -1 and 1 and keeps them private', async () => {
    await db.query(
      `insert into user_category_weights (user_id, category, weight) values ($1, 'meat', -0.5)`,
      [CAROL],
    )
    await assert.rejects(
      db.query(
        `insert into user_category_weights (user_id, category, weight) values ($1, 'fish', 2)`,
        [CAROL],
      ),
    )
    const bobSees = await as('authenticated', BOB, async () => {
      const goals = await db.query(
        'select count(*)::int as n from user_diet_goals',
      )
      const weights = await db.query(
        'select count(*)::int as n from user_category_weights',
      )
      return goals.rows[0].n + weights.rows[0].n
    })
    assert.equal(bobSees, 0)
  })
})

describe('import_recipe', () => {
  const payload = (url, extra = {}) => ({
    added_by: ALICE,
    source: { domain: 'www.example-blog.com', name: 'Example Blog' },
    recipe: {
      source_url: url,
      title: 'Black bean chili',
      image_url: 'https://example-blog.com/chili.jpg',
      servings: 6,
      total_minutes: 45,
      summary: "The author's own headnote",
      instructions: ['Their step one'],
    },
    cuisines: ['mexican', 'Dairy-Free'],
    ingredients: [
      { line_no: 0, raw_text: '2 cans black beans', section: '' },
      { line_no: 1, raw_text: '1 onion, diced', section: 'Toppings' },
      { line_no: 2, raw_text: '' },
    ],
    ...extra,
  })

  const importRecipe = (p) =>
    as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [p])
      return rows[0].r
    })

  it('stores a link-only recipe privately, without the author’s text', async () => {
    const r = await importRecipe(payload('https://example-blog.com/chili/'))
    assert.equal(r.created, true)
    assert.equal(r.visibility, 'private')
    assert.equal(r.status, 'needs_review')

    const { rows } = await db.query(
      `select r.summary, r.instructions, r.image_url, s.domain, s.content_rights,
              (select array_agg(raw_text order by line_no) from recipe_ingredients where recipe_id = r.id) as lines,
              (select array_agg(section order by line_no) from recipe_ingredients where recipe_id = r.id) as sections,
              (select array_agg(cuisine_slug) from recipe_cuisines where recipe_id = r.id) as cuisines,
              exists (select 1 from user_saved_recipes where recipe_id = r.id and user_id = $2) as saved
       from recipes r join recipe_sources s on s.id = r.source_id where r.id = $1`,
      [r.recipe_id, ALICE],
    )
    const got = rows[0]
    assert.equal(got.domain, 'example-blog.com')
    assert.equal(got.content_rights, 'link_only')
    assert.equal(got.summary, null)
    assert.equal(got.instructions, null)
    assert.equal(got.image_url, 'https://example-blog.com/chili.jpg')
    assert.deepEqual(got.lines, ['2 cans black beans', '1 onion, diced'])
    assert.deepEqual(got.sections, [null, 'Toppings'])
    assert.deepEqual(got.cuisines, ['mexican'])
    assert.equal(got.saved, true)
  })

  it('dedupes on the canonical URL and shares it with the next importer', async () => {
    const url = 'https://example-blog.com/lentil-soup/'
    const first = await importRecipe(payload(url))
    const second = await importRecipe({ ...payload(url), added_by: BOB })
    assert.equal(second.created, false)
    assert.equal(second.recipe_id, first.recipe_id)

    const visibleTo = (user) =>
      as('authenticated', user, async () => {
        const { rows } = await db.query(
          'select count(*)::int as n from recipes where id = $1',
          [first.recipe_id],
        )
        return rows[0].n
      })
    assert.equal(await visibleTo(ALICE), 1)
    assert.equal(await visibleTo(BOB), 1)
  })

  it('does not let a saved row expose a hand-typed private recipe', async () => {
    const handTyped = await recipe('Alice’s own', [], {
      url: null,
      visibility: 'private',
      addedBy: ALICE,
    })
    await db.query('update recipes set source_url = null where id = $1', [
      handTyped,
    ])
    await db.query(
      'insert into user_saved_recipes (user_id, recipe_id) values ($1, $2)',
      [BOB, handTyped],
    )
    const n = await as('authenticated', BOB, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from recipes where id = $1',
        [handTyped],
      )
      return rows[0].n
    })
    assert.equal(n, 0)
  })

  it('makes approved sources public and keeps text only when rights allow', async () => {
    await db.query(
      `insert into recipe_sources (name, domain, content_rights, crawl_enabled)
       values ('MyPlate', 'myplate.gov', 'public_domain', true)`,
    )
    const r = await importRecipe({
      ...payload('https://www.myplate.gov/recipes/veggie-chili'),
      source: { domain: 'www.myplate.gov', name: 'MyPlate Kitchen' },
    })
    assert.equal(r.visibility, 'public')
    const { rows } = await db.query(
      'select summary, instructions from recipes where id = $1',
      [r.recipe_id],
    )
    assert.equal(rows[0].summary, "The author's own headnote")
    assert.deepEqual(rows[0].instructions, ['Their step one'])
  })

  it('drops the image for an opted-out source and keeps it private', async () => {
    await db.query(
      `insert into recipe_sources (name, domain, crawl_enabled, opted_out_at)
       values ('Gone', 'opted-out.example', true, now())`,
    )
    const r = await importRecipe({
      ...payload('https://opted-out.example/stew/'),
      source: { domain: 'opted-out.example' },
    })
    assert.equal(r.visibility, 'private')
    const { rows } = await db.query(
      'select image_url from recipes where id = $1',
      [r.recipe_id],
    )
    assert.equal(rows[0].image_url, null)
  })

  it('refuses callers other than the API', async () => {
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query('select import_recipe($1)', [payload('https://x.example/a/')]),
      ),
      /only callable by the API/,
    )
  })

  it('requires a title, URL and domain', async () => {
    await assert.rejects(
      importRecipe({
        ...payload('https://x.example/b/'),
        recipe: { source_url: 'https://x.example/b/' },
      }),
      /required/,
    )
  })
})

describe('crawler', () => {
  const asApi = (sql, params) =>
    as('service_role', null, async () => (await db.query(sql, params)).rows)

  async function source(domain) {
    const { rows } = await db.query(
      `insert into recipe_sources (name, domain, crawl_enabled)
       values ($1, $1, true) returning id`,
      [domain],
    )
    return rows[0].id
  }

  const enqueue = async (sourceId, entries) =>
    (
      await asApi('select crawl_enqueue($1, $2) as n', [
        sourceId,
        JSON.stringify(entries),
      ])
    )[0].n

  const pageStatus = async (url) =>
    (
      await db.query(
        'select status, attempts from crawl_pages where url = $1',
        [url],
      )
    ).rows[0]

  it('queues new URLs once and re-queues them only when lastmod moves', async () => {
    const src = await source('queue.example')
    const a = 'https://queue.example/a/'
    const b = 'https://queue.example/b/'
    assert.equal(
      await enqueue(src, [
        { url: a, lastmod: '2026-09-01T00:00:00Z' },
        { url: b, lastmod: null },
        { url: b, lastmod: null },
        { url: '' },
      ]),
      2,
    )

    await db.query(
      `update crawl_pages set status = 'imported', fetched_lastmod = lastmod where url in ($1, $2)`,
      [a, b],
    )
    assert.equal(
      await enqueue(src, [
        { url: a, lastmod: '2026-09-01T00:00:00Z' },
        { url: b, lastmod: null },
      ]),
      0,
    )
    assert.equal(
      await enqueue(src, [{ url: a, lastmod: '2026-09-15T00:00:00Z' }]),
      1,
    )
    assert.equal((await pageStatus(a)).status, 'pending')
    assert.equal((await pageStatus(b)).status, 'imported')
  })

  it('never re-queues blocked or disallowed pages, and retries errors 3 times', async () => {
    const src = await source('stubborn.example')
    const blocked = 'https://stubborn.example/blocked/'
    const flaky = 'https://stubborn.example/flaky/'
    await enqueue(src, [{ url: blocked }, { url: flaky }])
    await db.query(`update crawl_pages set status = 'blocked' where url = $1`, [
      blocked,
    ])
    await db.query(
      `update crawl_pages set status = 'error', attempts = 2 where url = $1`,
      [flaky],
    )
    assert.equal(
      await enqueue(src, [{ url: blocked, lastmod: '2026-10-01T00:00:00Z' }]),
      1,
    )
    assert.equal((await pageStatus(blocked)).status, 'blocked')

    await db.query(`update crawl_pages set attempts = 3 where url = $1`, [
      flaky,
    ])
    assert.equal(await enqueue(src, []), 0)
    // A real change gives an errored page a fresh start.
    assert.equal(
      await enqueue(src, [{ url: flaky, lastmod: '2026-10-02T00:00:00Z' }]),
      1,
    )
    assert.deepEqual(await pageStatus(flaky), {
      status: 'pending',
      attempts: 0,
    })
  })

  it('does not let one source claim another source’s URL', async () => {
    const mine = await source('mine.example')
    const theirs = await source('theirs.example')
    const url = 'https://mine.example/x/'
    await enqueue(mine, [{ url }])
    await enqueue(theirs, [{ url, lastmod: '2026-10-01T00:00:00Z' }])
    const { rows } = await db.query(
      'select source_id, lastmod from crawl_pages where url = $1',
      [url],
    )
    assert.deepEqual(rows, [{ source_id: mine, lastmod: null }])
  })

  it('refreshes a changed recipe under the same content rules', async () => {
    await source('refresh.example')
    const base = {
      added_by: null,
      source: { domain: 'refresh.example' },
      recipe: {
        source_url: 'https://refresh.example/chili/',
        title: 'Chili',
        summary: 'Their headnote',
        instructions: ['Their step'],
      },
      cuisines: ['mexican'],
      ingredients: [{ line_no: 0, raw_text: '1 can beans' }],
    }
    const imp = async (p) =>
      (await asApi('select import_recipe($1) as r', [p]))[0].r
    const first = await imp(base)
    assert.equal(first.visibility, 'public')
    await db.query(`update recipes set status = 'active' where id = $1`, [
      first.recipe_id,
    ])

    const changed = {
      ...base,
      recipe: { ...base.recipe, title: 'Better chili' },
      cuisines: ['american'],
      ingredients: [
        { line_no: 0, raw_text: '2 cans beans' },
        { line_no: 1, raw_text: '1 onion' },
      ],
    }
    const skipped = await imp(changed)
    assert.deepEqual([skipped.created, skipped.updated], [false, false])

    const refreshed = await imp({ ...changed, refresh: true })
    assert.deepEqual(
      [
        refreshed.recipe_id,
        refreshed.created,
        refreshed.updated,
        refreshed.status,
      ],
      [first.recipe_id, false, true, 'needs_review'],
    )
    const { rows } = await db.query(
      `select r.title, r.summary, r.instructions,
              (select array_agg(raw_text order by line_no) from recipe_ingredients where recipe_id = r.id) as lines,
              (select array_agg(cuisine_slug) from recipe_cuisines where recipe_id = r.id) as cuisines
       from recipes r where r.id = $1`,
      [first.recipe_id],
    )
    assert.deepEqual(rows[0], {
      title: 'Better chili',
      summary: null,
      instructions: null,
      lines: ['2 cans beans', '1 onion'],
      cuisines: ['american'],
    })
  })

  it('does not refresh a hidden or removed recipe', async () => {
    await source('hidden.example')
    const p = {
      source: { domain: 'hidden.example' },
      recipe: { source_url: 'https://hidden.example/x/', title: 'X' },
    }
    const { recipe_id } = (await asApi('select import_recipe($1) as r', [p]))[0]
      .r
    await db.query(`update recipes set status = 'removed' where id = $1`, [
      recipe_id,
    ])
    const r = (
      await asApi('select import_recipe($1) as r', [
        { ...p, recipe: { ...p.recipe, title: 'Y' }, refresh: true },
      ])
    )[0].r
    assert.equal(r.updated, false)
    assert.equal(r.status, 'removed')
  })

  it('opting a source out hides its public recipes but not private copies', async () => {
    const src = await source('leaving.example')
    const pub = await recipe('Leaving public', [], {
      url: 'https://leaving.example/pub/',
    })
    const priv = await recipe('Leaving private', [], {
      url: 'https://leaving.example/priv/',
      visibility: 'private',
      addedBy: ALICE,
    })
    await db.query('update recipes set source_id = $1 where id in ($2, $3)', [
      src,
      pub,
      priv,
    ])
    const [{ n }] = await asApi('select opt_out_source($1) as n', [src])
    assert.equal(n, 1)

    const { rows } = await db.query(
      `select (select status from recipes where id = $2) as pub,
              (select status from recipes where id = $3) as priv,
              s.crawl_enabled, s.opted_out_at is not null as opted_out
       from recipe_sources s where s.id = $1`,
      [src, pub, priv],
    )
    assert.deepEqual(rows[0], {
      pub: 'hidden',
      priv: 'active',
      crawl_enabled: false,
      opted_out: true,
    })
  })

  it('keeps the crawl tables and functions away from users', async () => {
    const src = await source('private-queue.example')
    await enqueue(src, [{ url: 'https://private-queue.example/a/' }])
    await db.query('insert into crawl_runs (source_id) values ($1)', [src])
    for (const [role, user] of [
      ['anon', null],
      ['authenticated', ALICE],
    ]) {
      const counts = await as(role, user, async () => {
        const pages = await db.query(
          'select count(*)::int as n from crawl_pages',
        )
        const runs = await db.query('select count(*)::int as n from crawl_runs')
        return [pages.rows[0].n, runs.rows[0].n]
      })
      assert.deepEqual(counts, [0, 0])
      await assert.rejects(
        as(role, user, () =>
          db.query('select crawl_enqueue($1, $2)', [src, '[]']),
        ),
        /only callable by the API/,
      )
      await assert.rejects(
        as(role, user, () => db.query('select opt_out_source($1)', [src])),
        /only callable by the API/,
      )
    }
  })
})

describe('browser import', () => {
  const imp = (p) =>
    as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [p])
      return rows[0].r
    })

  const page = (url, user, title = 'Chana masala', extra = {}) => ({
    added_by: user,
    origin: 'browser',
    source: { domain: 'blocked-blog.example', name: 'Blocked Blog' },
    recipe: {
      source_url: url,
      title,
      summary: 'Their headnote',
      instructions: ['Their step'],
    },
    ingredients: [{ line_no: 0, raw_text: '1 can chickpeas' }],
    ...extra,
  })

  const row = async (id) =>
    (
      await db.query(
        `select origin, visibility, added_by, title, summary, instructions,
                (select array_agg(raw_text order by line_no) from recipe_ingredients where recipe_id = r.id) as lines
         from recipes r where id = $1`,
        [id],
      )
    ).rows[0]

  it('keeps a private copy for the user, without the author’s text', async () => {
    const r = await imp(page('https://blocked-blog.example/chana/', ALICE))
    assert.deepEqual([r.created, r.visibility], [true, 'private'])
    const got = await row(r.recipe_id)
    assert.equal(got.origin, 'browser')
    assert.equal(got.added_by, ALICE)
    assert.equal(got.summary, null)
    assert.equal(got.instructions, null)
    assert.deepEqual(got.lines, ['1 can chickpeas'])
  })

  it('gives each user their own copy, so made-up data reaches no one else', async () => {
    const url = 'https://blocked-blog.example/forged/'
    const fake = await imp(page(url, ALICE, 'Totally real recipe'))
    const bobs = await imp(page(url, BOB, 'Chana masala'))
    assert.notEqual(bobs.recipe_id, fake.recipe_id)
    assert.equal((await row(bobs.recipe_id)).title, 'Chana masala')

    // Bob can't see Alice's copy, and a server import doesn't reuse it.
    const seen = await as('authenticated', BOB, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from recipes where id = $1',
        [fake.recipe_id],
      )
      return rows[0].n
    })
    assert.equal(seen, 0)
    const fetched = await imp({ ...page(url, BOB), origin: undefined })
    assert.notEqual(fetched.recipe_id, fake.recipe_id)
    assert.equal((await row(fetched.recipe_id)).origin, 'fetched')
  })

  it('updates the user’s copy when they import the page again', async () => {
    const url = 'https://blocked-blog.example/again/'
    const first = await imp(page(url, ALICE, 'Draft title'))
    const again = await imp(
      page(url, ALICE, 'Final title', {
        ingredients: [
          { line_no: 0, raw_text: '2 cans chickpeas' },
          { line_no: 1, raw_text: '1 onion' },
        ],
      }),
    )
    assert.deepEqual(
      [again.recipe_id, again.created, again.updated],
      [first.recipe_id, false, true],
    )
    const got = await row(first.recipe_id)
    assert.equal(got.title, 'Final title')
    assert.deepEqual(got.lines, ['2 cans chickpeas', '1 onion'])
  })

  it('reuses a recipe Sous fetched itself instead of the browser’s data', async () => {
    const url = 'https://blocked-blog.example/trusted/'
    const trusted = await imp({
      ...page(url, BOB, 'Trusted title'),
      origin: undefined,
    })
    const r = await imp(page(url, ALICE, 'Browser title'))
    assert.deepEqual([r.recipe_id, r.created], [trusted.recipe_id, false])
    assert.equal((await row(trusted.recipe_id)).title, 'Trusted title')
    const { rows } = await db.query(
      'select 1 from user_saved_recipes where user_id = $1 and recipe_id = $2',
      [ALICE, trusted.recipe_id],
    )
    assert.equal(rows.length, 1)
  })

  it('never makes browser data public, even from an approved source', async () => {
    await db.query(
      `insert into recipe_sources (name, domain, crawl_enabled) values ('Approved', 'approved-blog.example', true)`,
    )
    const r = await imp({
      ...page('https://approved-blog.example/x/', ALICE),
      source: { domain: 'approved-blog.example' },
    })
    assert.equal(r.visibility, 'private')
    await assert.rejects(
      db.query(`update recipes set visibility = 'public' where id = $1`, [
        r.recipe_id,
      ]),
      /recipes_browser_private/,
    )
  })

  it('never lets browser data name a source that everyone sees', async () => {
    await imp({
      ...page('https://fresh-blog.example/x/', ALICE),
      source: {
        domain: 'fresh-blog.example',
        name: 'Scam Recipes',
        homepage_url: 'https://scam.example/',
      },
    })
    const { rows } = await db.query(
      `select name, homepage_url from recipe_sources where domain = 'fresh-blog.example'`,
    )
    assert.deepEqual(rows[0], {
      name: 'fresh-blog.example',
      homepage_url: 'https://fresh-blog.example/',
    })

    // An existing source keeps its name.
    await db.query(
      `insert into recipe_sources (name, domain) values ('Named Blog', 'named-blog.example')`,
    )
    await imp({
      ...page('https://named-blog.example/renamed/', ALICE),
      source: { domain: 'named-blog.example', name: 'Renamed' },
    })
    const kept = await db.query(
      `select name from recipe_sources where domain = 'named-blog.example'`,
    )
    assert.equal(kept.rows[0].name, 'Named Blog')
  })

  it('requires a user and a known origin', async () => {
    await assert.rejects(
      imp(page('https://blocked-blog.example/a/', null)),
      /needs added_by/,
    )
    await assert.rejects(
      imp({
        ...page('https://blocked-blog.example/b/', ALICE),
        origin: 'email',
      }),
      /origin must be/,
    )
  })
})

describe('ingredient parsing', () => {
  const ingredientId = async (name) =>
    (
      await db.query('select id from ingredients where lower(name) = $1', [
        name,
      ])
    ).rows[0]?.id
  const match = async (candidates) =>
    (await db.query('select match_ingredient($1) as id', [candidates])).rows[0]
      .id

  it('seeds aliases that all point at real ingredients', async () => {
    const { rows } = await db.query(
      'select count(*)::int as n from ingredient_aliases',
    )
    // Seed migration + more_ingredients + everyday_ingredients (TYL-60).
    assert.equal(rows[0].n, 159 + 283 + 235 + 322) // + ingredients_from_recipes
    assert.equal(await match(['fettuccine pasta']), await ingredientId('pasta'))
    assert.equal(await match(['green onions']), await ingredientId('scallions'))
    assert.equal(await match(['kosher salt']), await ingredientId('salt'))
  })

  it('takes the first candidate that names an ingredient or alias', async () => {
    const canned = await ingredientId('canned chickpeas')
    assert.equal(
      await match(['canned chickpeas', 'chickpeas', 'dried chickpeas']),
      canned,
    )
    assert.equal(
      await match(['large ripe avocados', 'ripe avocados', 'avocados']),
      await ingredientId('avocado'),
    )
    assert.equal(await match(['dragon fruit', 'dragon fruits']), null)
    assert.equal(await match([]), null)
  })

  it('stores parsed lines, alternatives as options, and flags what it cannot match', async () => {
    const id = await recipe('Parsed stew', [])
    const n = (
      await as('service_role', null, () =>
        db.query('select set_recipe_ingredients($1, $2) as n', [
          id,
          JSON.stringify([
            {
              line_no: 0,
              raw_text: '1 (15 oz) can chickpeas',
              name: 'chickpeas',
              candidates: ['canned chickpeas', 'chickpeas'],
              quantity: 15,
              unit: 'oz',
              note: '1 can',
              parse_confidence: 0.96,
            },
            {
              line_no: 1,
              option_no: 1,
              raw_text: '2 tbsp yuzu kosho (or soy sauce)',
              name: 'yuzu kosho',
              candidates: ['yuzu kosho'],
              quantity: 2,
              unit: 'tbsp',
            },
            {
              line_no: 1,
              option_no: 2,
              raw_text: '2 tbsp yuzu kosho (or soy sauce)',
              name: 'soy sauce',
              candidates: ['soy sauce'],
              quantity: 2,
              unit: 'tbsp',
              needs_review: true,
            },
            { line_no: 2, raw_text: 'For the topping:' },
            { line_no: 3, raw_text: '' },
          ]),
        ]),
      )
    ).rows[0].n
    assert.equal(n, 4)
    const { rows } = await db.query(
      `select line_no, option_no, name, ingredient_id is not null as matched, quantity::float,
              unit, note, needs_review
       from recipe_ingredients where recipe_id = $1 order by line_no, option_no`,
      [id],
    )
    assert.deepEqual(rows, [
      {
        line_no: 0,
        option_no: 1,
        name: 'chickpeas',
        matched: true,
        quantity: 15,
        unit: 'oz',
        note: '1 can',
        needs_review: false,
      },
      {
        line_no: 1,
        option_no: 1,
        name: 'yuzu kosho',
        matched: false,
        quantity: 2,
        unit: 'tbsp',
        note: null,
        needs_review: true,
      },
      {
        line_no: 1,
        option_no: 2,
        name: 'soy sauce',
        matched: true,
        quantity: 2,
        unit: 'tbsp',
        note: null,
        needs_review: true,
      },
      {
        line_no: 2,
        option_no: 1,
        name: null,
        matched: false,
        quantity: null,
        unit: null,
        note: null,
        needs_review: false,
      },
    ])
  })

  it('replaces the lines when a recipe is parsed again', async () => {
    const id = await recipe('Reparsed', [])
    const set = (rows) =>
      as('service_role', null, () =>
        db.query('select set_recipe_ingredients($1, $2)', [
          id,
          JSON.stringify(rows),
        ]),
      )
    await set([{ line_no: 0, raw_text: 'old line', name: 'old' }])
    await set([
      { line_no: 0, raw_text: '1 onion', name: 'onion', candidates: ['onion'] },
    ])
    const { rows } = await db.query(
      'select raw_text, name from recipe_ingredients where recipe_id = $1',
      [id],
    )
    assert.deepEqual(rows, [{ raw_text: '1 onion', name: 'onion' }])
  })

  it('imports parsed lines through import_recipe', async () => {
    const r = await as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [
        {
          added_by: ALICE,
          source: { domain: 'parsed-blog.example' },
          recipe: {
            source_url: 'https://parsed-blog.example/soup/',
            title: 'Soup',
          },
          ingredients: [
            {
              line_no: 0,
              raw_text: '3 green onions, sliced',
              name: 'green onions',
              candidates: ['green onions', 'green onion'],
              quantity: 3,
              unit: 'each',
              preparation: 'sliced',
            },
          ],
        },
      ])
      return rows[0].r
    })
    const { rows } = await db.query(
      `select ri.preparation, i.name as ingredient
       from recipe_ingredients ri left join ingredients i on i.id = ri.ingredient_id
       where ri.recipe_id = $1`,
      [r.recipe_id],
    )
    assert.deepEqual(rows, [{ preparation: 'sliced', ingredient: 'scallions' }])
  })

  it('only lets the API replace ingredient lines', async () => {
    const id = await recipe('Locked', [])
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query('select set_recipe_ingredients($1, $2)', [id, '[]']),
      ),
      /only callable by the API/,
    )
  })
})

describe('ingredient list (apps/api/data/ingredients.csv)', () => {
  const split = (cell) =>
    cell
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)
      .sort()
  let rows

  before(async () => {
    const text = await readFile(
      new URL('../../apps/api/data/ingredients.csv', import.meta.url),
      'utf8',
    )
    const [, ...lines] = text.trim().split('\n')
    rows = lines.map((line) => {
      const [name, aisle, contains, may, aliases] = line.split(',')
      return {
        name,
        aisle,
        contains: split(contains),
        may: split(may),
        aliases: split(aliases),
      }
    })
  })

  it('stores every ingredient with the aisle and diet facts in the CSV', async () => {
    const { rows: stored } = await db.query(
      `select name, aisle, contains, may_contain from ingredients where name = any($1)`,
      [rows.map((r) => r.name)],
    )
    const got = new Map(stored.map((r) => [r.name, r]))
    for (const r of rows) {
      const g = got.get(r.name)
      assert.ok(g, `${r.name} missing (does it already exist?)`)
      assert.equal(g.aisle, r.aisle, r.name)
      assert.deepEqual([...g.contains].sort(), r.contains, `${r.name} contains`)
      assert.deepEqual(
        [...g.may_contain].sort(),
        r.may,
        `${r.name} may_contain`,
      )
    }
  })

  it('points every alias at its own ingredient (no clash with older aliases)', async () => {
    for (const r of rows) {
      for (const alias of r.aliases) {
        const { rows: hit } = await db.query(
          `select i.name from ingredient_aliases a join ingredients i on i.id = a.ingredient_id where a.alias = $1`,
          [alias],
        )
        assert.equal(hit[0]?.name, r.name, `alias ${alias}`)
      }
    }
  })

  it('reads typical recipe names as the right ingredient', async () => {
    const cases = [
      [['heavy cream'], 'heavy cream'],
      [['fresh parsley', 'parsley'], 'parsley'],
      [['beef stock'], 'beef broth'],
      [['dried oregano'], 'dried oregano'],
      [['fresh basil', 'basil'], 'basil'],
      [['ground ginger'], 'ground ginger'],
      [['fresh ginger'], 'ginger'],
      [['oat milk'], 'oat milk'],
      [['milk'], 'whole milk'],
    ]
    for (const [candidates, expected] of cases) {
      const { rows: hit } = await db.query(
        'select name from ingredients where id = match_ingredient($1)',
        [candidates],
      )
      assert.equal(hit[0]?.name, expected, candidates.join(' / '))
    }
  })
})

describe('diet labels', () => {
  const line = (n, name, extra = {}) => ({
    line_no: n,
    raw_text: name,
    name,
    candidates: [name],
    ...extra,
  })
  const label = async (title, lines) => {
    const id = await recipe(title, [])
    await as('service_role', null, () =>
      db.query('select set_recipe_ingredients($1, $2)', [
        id,
        JSON.stringify(lines),
      ]),
    )
    return id
  }
  const diets = async (id, source = 'derived') =>
    (
      await db.query(
        'select diet_slug from recipe_diets where recipe_id = $1 and source = $2 order by 1',
        [id, source],
      )
    ).rows.map((r) => r.diet_slug)

  it('labels a recipe with every diet its ingredients clearly fit', async () => {
    const id = await label('Garlic pasta', [
      line(0, 'pasta'),
      line(1, 'garlic'),
      line(2, 'olive oil'),
      line(3, 'parmesan'),
    ])
    const got = await diets(id)
    assert.ok(got.includes('vegetarian'))
    assert.ok(got.includes('egg_free'))
    assert.ok(!got.includes('vegan'), 'parmesan is dairy')
    assert.ok(!got.includes('gluten_free'), 'pasta has gluten')
  })

  it('never calls a recipe vegetarian when a line has meat, fish or gelatin', async () => {
    for (const hidden of [
      'chicken broth',
      'worcestershire sauce',
      'gelatin',
      'anchovies',
    ]) {
      const id = await label(`Soup with ${hidden}`, [
        line(0, 'onion'),
        line(1, hidden),
      ])
      assert.ok(!(await diets(id)).includes('vegetarian'), hidden)
    }
  })

  it('gives no label when it cannot tell', async () => {
    const unknown = await label('Mystery stew', [
      line(0, 'onion'),
      line(1, 'dragonfruit jam'),
    ])
    assert.ok(!(await diets(unknown)).includes('vegetarian'))
  })

  it('labels a recipe that fits depending on brand, naming what to check', async () => {
    // refried beans may contain lard (meat, pork); vegetarian excludes meat, no-pork excludes pork
    const id = await label('Bean burritos', [
      line(0, 'refried beans'),
      line(1, 'onion'),
    ])
    const { rows } = await db.query(
      `select diet_slug, checks from recipe_diets where recipe_id = $1 and source = 'derived'`,
      [id],
    )
    const by = Object.fromEntries(rows.map((r) => [r.diet_slug, r.checks]))
    assert.deepEqual(by.vegetarian, [
      { ingredient: 'refried beans', may_contain: ['meat'] },
    ])
    assert.deepEqual(by.no_pork, [
      { ingredient: 'refried beans', may_contain: ['pork'] },
    ])
    assert.deepEqual(by.gluten_free, [], 'nothing to check for gluten')
  })

  it('only checks lines that have no clearly fitting option', async () => {
    // corn tortillas clearly fit, so the flour tortilla option needs no check
    const id = await label('Tacos', [
      line(0, 'flour tortillas', { option_no: 1 }),
      line(0, 'corn tortillas', { option_no: 2 }),
      line(1, 'refried beans'),
    ])
    const { rows } = await db.query(
      `select checks from recipe_diets where recipe_id = $1 and diet_slug = 'vegetarian'`,
      [id],
    )
    assert.deepEqual(rows[0].checks, [
      { ingredient: 'refried beans', may_contain: ['meat'] },
    ])
  })

  it('counts an alternative that fits, and ignores optional lines', async () => {
    const id = await label('Stir fry', [
      line(0, 'firm tofu'),
      line(1, 'fish sauce', { option_no: 1 }),
      line(1, 'soy sauce', { option_no: 2 }),
      line(2, 'chicken thighs', { is_optional: true }),
    ])
    assert.ok((await diets(id)).includes('vegetarian'))
  })

  it('gives a recipe with no ingredient lines no labels', async () => {
    const id = await label('Empty', [
      { line_no: 0, raw_text: 'For the sauce:' },
    ])
    assert.deepEqual(await diets(id), [])
  })

  it('updates labels when the ingredients change', async () => {
    const id = await label('Changing', [line(0, 'onion')])
    assert.ok((await diets(id)).includes('vegan'))
    await as('service_role', null, () =>
      db.query('select set_recipe_ingredients($1, $2)', [
        id,
        JSON.stringify([line(0, 'onion'), line(1, 'butter')]),
      ]),
    )
    const got = await diets(id)
    assert.ok(!got.includes('vegan'))
    assert.ok(got.includes('vegetarian'))
  })

  it('keeps publisher tags as hints and lets derived labels win', async () => {
    const r = await as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [
        {
          added_by: ALICE,
          source: { domain: 'hint-blog.example' },
          recipe: {
            source_url: 'https://hint-blog.example/x/',
            title: 'Claims',
          },
          publisher_diets: ['vegetarian', 'vegan', 'not_a_diet'],
          ingredients: [line(0, 'onion'), line(1, 'butter')],
        },
      ])
      return rows[0].r
    })
    // butter: vegetarian is derived, vegan stays only a publisher claim
    assert.ok((await diets(r.recipe_id)).includes('vegetarian'))
    assert.deepEqual(await diets(r.recipe_id, 'publisher'), ['vegan'])
  })

  it('leaves a reviewer’s manual label alone', async () => {
    const id = await recipe('Reviewed', [])
    await db.query(
      `insert into recipe_diets (recipe_id, diet_slug, source) values ($1, 'vegetarian', 'manual')`,
      [id],
    )
    await as('service_role', null, () =>
      db.query('select set_recipe_ingredients($1, $2)', [
        id,
        JSON.stringify([line(0, 'onion')]),
      ]),
    )
    const { rows } = await db.query(
      `select source from recipe_diets where recipe_id = $1 and diet_slug = 'vegetarian'`,
      [id],
    )
    assert.deepEqual(rows, [{ source: 'manual' }])
  })

  it('only lets the API refresh labels', async () => {
    const id = await recipe('Locked labels', [])
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query('select refresh_recipe_diets($1)', [id]),
      ),
      /only callable by the API/,
    )
  })
})

describe('hand-typed recipes', () => {
  const save = (p) =>
    as('service_role', null, async () => {
      const { rows } = await db.query('select save_manual_recipe($1) as r', [p])
      return rows[0].r
    })
  const mine = (extra = {}) => ({
    added_by: ALICE,
    recipe: {
      title: 'Grandma’s lentil soup',
      servings: 4,
      total_minutes: 45,
      instructions: ['Soften the onion.', 'Simmer everything.'],
      source_note: 'Grandma',
    },
    cuisines: ['middle_eastern', 'not_a_cuisine'],
    ingredients: [
      {
        line_no: 0,
        raw_text: '1 cup red lentils',
        name: 'red lentils',
        candidates: ['red lentils', 'lentils'],
        quantity: 1,
        unit: 'cup',
      },
      {
        line_no: 1,
        raw_text: '1 onion',
        name: 'onion',
        candidates: ['onion'],
        quantity: 1,
        unit: 'each',
      },
    ],
    ...extra,
  })

  it('stores everything the user typed, privately, and saves it for them', async () => {
    const r = await save(mine())
    assert.equal(r.created, true)
    const { rows } = await db.query(
      `select title, instructions, source_note, source_url, visibility, status, added_by,
              (select count(*)::int from recipe_ingredients where recipe_id = r.id) as lines,
              (select array_agg(cuisine_slug) from recipe_cuisines where recipe_id = r.id) as cuisines,
              exists (select 1 from recipe_diets where recipe_id = r.id and diet_slug = 'vegan') as vegan,
              exists (select 1 from user_saved_recipes where recipe_id = r.id and user_id = $2) as saved
       from recipes r where r.id = $1`,
      [r.recipe_id, ALICE],
    )
    assert.deepEqual(rows[0], {
      title: 'Grandma’s lentil soup',
      instructions: ['Soften the onion.', 'Simmer everything.'],
      source_note: 'Grandma',
      source_url: null,
      visibility: 'private',
      status: 'active',
      added_by: ALICE,
      lines: 2,
      cuisines: ['middle_eastern'],
      vegan: true,
      saved: true,
    })
    const seen = await as('authenticated', BOB, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from recipes where id = $1',
        [r.recipe_id],
      )
      return rows[0].n
    })
    assert.equal(seen, 0, 'private to its author')
  })

  it('lets the author edit it, with labels updated', async () => {
    const { recipe_id } = await save(mine())
    const r = await save(
      mine({
        recipe_id,
        recipe: { title: 'Lentil soup with butter' },
        ingredients: [
          {
            line_no: 0,
            raw_text: '2 tbsp butter',
            name: 'butter',
            candidates: ['butter'],
          },
        ],
      }),
    )
    assert.deepEqual([r.recipe_id, r.created], [recipe_id, false])
    const { rows } = await db.query(
      `select title, instructions,
              exists (select 1 from recipe_diets where recipe_id = $1 and diet_slug = 'vegan') as vegan
       from recipes where id = $1`,
      [recipe_id],
    )
    assert.deepEqual(rows[0], {
      title: 'Lentil soup with butter',
      instructions: null,
      vegan: false,
    })
  })

  it('refuses to edit someone else’s recipe or an imported one', async () => {
    const { recipe_id } = await save(mine())
    await assert.rejects(
      save(mine({ recipe_id, added_by: BOB })),
      /no such recipe of yours/,
    )
    const imported = await as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [
        {
          added_by: ALICE,
          source: { domain: 'edit-blog.example' },
          recipe: {
            source_url: 'https://edit-blog.example/x/',
            title: 'Imported',
          },
        },
      ])
      return rows[0].r
    })
    await assert.rejects(
      save(mine({ recipe_id: imported.recipe_id })),
      /no such recipe of yours/,
    )
  })

  it('requires a title and the API', async () => {
    await assert.rejects(
      save(mine({ recipe: { title: '  ' } })),
      /title are required/,
    )
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query('select save_manual_recipe($1)', [mine()]),
      ),
      /only callable by the API/,
    )
  })
})

describe('meal planner', () => {
  const DAVE = '00000000-0000-0000-0000-00000000000d'
  const MONDAY = '2026-10-12'
  let soup, alicesSecret, peanutNoodles

  before(async () => {
    await db.query('insert into auth.users (id) values ($1)', [DAVE])
    const lentils = await ingredient('red lentils')
    const peanuts = await ingredient('peanut butter', ['peanut'])
    soup = await recipe('Planner soup', [[lentils]])
    await db.query('update recipes set servings = 4 where id = $1', [soup])
    await db.query(
      `update recipe_ingredients set quantity = 2, unit = 'cup' where recipe_id = $1`,
      [soup],
    )
    peanutNoodles = await recipe('Planner peanut noodles', [[peanuts]])
    alicesSecret = await recipe('Alice planner secret', [[lentils]], {
      visibility: 'private',
      addedBy: ALICE,
    })
  })

  const asDave = (sql, params) =>
    as('authenticated', DAVE, async () => (await db.query(sql, params)).rows)

  it('adds recipes to a week, creating the plan once', async () => {
    await asDave('select add_to_meal_plan($1, $2, 2)', [MONDAY, soup])
    await asDave('select add_to_meal_plan($1, $2, 0.5, $3)', [
      MONDAY,
      soup,
      '2026-10-14',
    ])
    const rows = await asDave(
      `select e.scale::float as scale, e.planned_for::text, e.position
       from meal_plan_entries e join meal_plans p on p.id = e.meal_plan_id
       where p.week_start = $1 order by e.position`,
      [MONDAY],
    )
    assert.deepEqual(rows, [
      { scale: 2, planned_for: null, position: 0 },
      { scale: 0.5, planned_for: '2026-10-14', position: 1 },
    ])
    const plans = await asDave('select count(*)::int as n from meal_plans')
    assert.equal(plans[0].n, 1)
  })

  it('only plans weeks that start on Monday, and days inside the week', async () => {
    await assert.rejects(
      asDave('select add_to_meal_plan($1, $2, 2)', ['2026-10-13', soup]),
      /meal_plans_week_starts_monday/,
    )
    await assert.rejects(
      asDave('select add_to_meal_plan($1, $2, 2, $3)', [
        MONDAY,
        soup,
        '2026-10-20',
      ]),
      /not in this week/,
    )
  })

  it("won't plan someone else's private recipe", async () => {
    await assert.rejects(
      asDave('select add_to_meal_plan($1, $2, 2)', [MONDAY, alicesSecret]),
      /row-level security/,
    )
  })

  it('copies a week to another, keeping weekdays', async () => {
    const [{ n }] = await asDave('select copy_meal_plan($1, $2) as n', [
      MONDAY,
      '2026-10-19',
    ])
    assert.equal(n, 2)
    const days = await asDave(
      `select e.planned_for::text as day from meal_plan_entries e
       join meal_plans p on p.id = e.meal_plan_id
       where p.week_start = '2026-10-19' order by e.position`,
    )
    assert.deepEqual(
      days.map((d) => d.day),
      [null, '2026-10-21'],
    )
    const [{ none }] = await asDave('select copy_meal_plan($1, $2) as none', [
      '2026-01-05',
      '2026-10-26',
    ])
    assert.equal(none, 0, 'nothing to copy from an empty week')
  })

  it("tells the user how recipes fit what they've ruled out", async () => {
    await db.query(
      `insert into profiles (user_id, allergens) values ($1, '{peanut}')
       on conflict (user_id) do update set allergens = excluded.allergens`,
      [DAVE],
    )
    const rows = await asDave(
      'select recipe_id, fit from my_recipe_fits($1) order by fit',
      [[soup, peanutNoodles, alicesSecret]],
    )
    assert.deepEqual(rows, [
      { recipe_id: peanutNoodles, fit: 'excluded' },
      { recipe_id: soup, fit: 'fits' },
    ])
  })

  it('gives the API what it needs to price a week, and only the API', async () => {
    const lentils = await ingredient('red lentils')
    await db.query(
      `insert into prices (source, ingredient_id, price_cents, quantity, unit, user_id)
       values ('seed', $1, 300, 1, 'lb', null), ('user', $1, 250, 1, 'lb', $2),
              ('user', $1, 1, 1, 'lb', $3)`,
      [lentils, DAVE, ALICE],
    )
    await db.query(
      `update profiles set weekly_budget_cents = 8000 where user_id = $1`,
      [DAVE],
    )
    const r = await as('service_role', null, async () => {
      const { rows } = await db.query('select plan_cost_inputs($1, $2) as r', [
        DAVE,
        MONDAY,
      ])
      return rows[0].r
    })
    assert.equal(r.budget_cents, 8000)
    assert.equal(r.entries.length, 2)
    assert.deepEqual(r.entries[0].lines, [
      { ingredient_id: lentils, quantity: 2, unit: 'cup', raw_text: 'line' },
    ])
    assert.equal(r.entries[0].scale, 2)
    assert.ok(r.ingredients[lentils])
    assert.deepEqual(r.prices.map((p) => p.price_cents).sort(), [250, 300])
    await assert.rejects(
      asDave('select plan_cost_inputs($1, $2)', [DAVE, MONDAY]),
      /only callable by the API/,
    )
  })
})

describe('buying: packages, recipe sizes and the pantry', () => {
  it('says how every ingredient is bought', async () => {
    const { rows } = await db.query(
      `select count(*)::int as missing from ingredients where sold_by is null`,
    )
    // Rows added by earlier tests have no packaging; every seeded one does.
    const seeded = await db.query(
      `select count(*)::int as n from ingredients
       where sold_by is null and name in ('salt', 'eggs', 'carrots', 'lentils')`,
    )
    assert.equal(seeded.rows[0].n, 0)
    assert.ok(rows[0].missing < 20)
    const { rows: eggs } = await db.query(
      `select sold_by, package_quantity::int as qty, package_unit, pantry_staple
       from ingredients where name in ('eggs', 'carrots', 'salt') order by name`,
    )
    assert.deepEqual(eggs, [
      { sold_by: 'loose', qty: null, package_unit: null, pantry_staple: false },
      {
        sold_by: 'package',
        qty: 12,
        package_unit: 'each',
        pantry_staple: false,
      },
      { sold_by: 'package', qty: 26, package_unit: 'oz', pantry_staple: true },
    ])
  })

  it('needs a size for packaged ingredients only', async () => {
    await assert.rejects(
      db.query(
        `insert into ingredients (name, sold_by) values ('test package', 'package')`,
      ),
      /ingredients_package_size/,
    )
    await assert.rejects(
      db.query(
        `insert into ingredients (name, sold_by, package_quantity, package_unit)
         values ('test loose', 'loose', 1, 'lb')`,
      ),
      /ingredients_package_size/,
    )
  })

  it('plans recipes at half, full or double size only', async () => {
    const r = await recipe('Sized soup', [[await ingredient('red lentils')]])
    await db.query('insert into auth.users (id) values ($1)', [
      '00000000-0000-0000-0000-0000000000e1',
    ])
    await assert.rejects(
      as('authenticated', '00000000-0000-0000-0000-0000000000e1', () =>
        db.query("select add_to_meal_plan('2026-10-12', $1, 3)", [r]),
      ),
      /scale_check/,
    )
  })

  it('keeps each pantry private to its user', async () => {
    const salt = (
      await db.query("select id from ingredients where name = 'salt'")
    ).rows[0].id
    await as('authenticated', ALICE, () =>
      db.query(
        "insert into user_pantry (user_id, ingredient_id, status) values ($1, $2, 'out')",
        [ALICE, salt],
      ),
    )
    const seen = await as('authenticated', BOB, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from user_pantry',
      )
      return rows[0].n
    })
    assert.equal(seen, 0)
    await assert.rejects(
      as('authenticated', BOB, () =>
        db.query(
          "insert into user_pantry (user_id, ingredient_id, status) values ($1, $2, 'have')",
          [ALICE, salt],
        ),
      ),
      /row-level security/,
    )
  })

  it('gives the API how ingredients are bought and what the pantry says', async () => {
    const USER = '00000000-0000-0000-0000-0000000000e2'
    await db.query('insert into auth.users (id) values ($1)', [USER])
    const salt = (
      await db.query("select id from ingredients where name = 'salt'")
    ).rows[0].id
    const r = await recipe('Salted water', [[salt]])
    await as('authenticated', USER, async () => {
      await db.query("select add_to_meal_plan('2026-10-12', $1, 2)", [r])
      await db.query(
        "insert into user_pantry (user_id, ingredient_id, status) values ($1, $2, 'out')",
        [USER, salt],
      )
    })
    const inputs = await as('service_role', null, async () => {
      const { rows } = await db.query(
        "select plan_cost_inputs($1, '2026-10-12') as r",
        [USER],
      )
      return rows[0].r
    })
    assert.equal(inputs.entries[0].scale, 2)
    assert.deepEqual(inputs.ingredients[salt], {
      name: 'salt',
      aisle: 'spices',
      grams_per_cup: inputs.ingredients[salt].grams_per_cup,
      grams_per_each: null,
      sold_by: 'package',
      package_quantity: 26,
      package_unit: 'oz',
      pantry_staple: true,
      pantry: 'out',
      units: {},
      buy_as: null,
      buy_ratio: null,
    })
  })
})

describe('ingredient weights and the everyday list (TYL-60)', () => {
  const one = async (name) =>
    (
      await db.query(
        `select grams_per_cup::float as cup, grams_per_each::float as each,
                sold_by, package_quantity::float as qty, package_unit, contains, may_contain
         from ingredients where name = $1`,
        [name],
      )
    ).rows[0]

  it('fills in cup and item weights from USDA data', async () => {
    assert.equal((await one('heavy cream')).cup, 238)
    assert.equal((await one('carrots')).each, 61)
    assert.equal((await one('tomatillos')).each, 34)
    assert.equal(
      (await one('mixed greens')).each,
      null,
      'one "mixed green" is meaningless',
    )
  })

  it('keeps weights that were set by hand', async () => {
    // onion: 150 g each in the baseline migration; USDA says 110 for a medium one.
    assert.deepEqual(
      [(await one('onion')).cup, (await one('onion')).each],
      [160, 150],
    )
    assert.equal((await one('eggs')).each, 50)
  })

  it('adds everyday ingredients with packaging and diet categories', async () => {
    assert.deepEqual(await one('tortellini'), {
      cup: null,
      each: null,
      sold_by: 'package',
      qty: 9,
      package_unit: 'oz',
      contains: ['gluten', 'egg', 'dairy'],
      may_contain: ['animal_rennet'],
    })
    assert.equal((await one('lard')).contains.includes('pork'), true)
    assert.deepEqual((await one('hummus')).contains, ['sesame'])
    const { rows } = await db.query(
      `select count(*)::int as n from ingredients i
       where i.name in ('jicama', 'gouda', 'halibut', 'wasabi', 'cream of tartar')
         and i.sold_by is not null`,
    )
    // halibut was already an alias, so it isn't a new ingredient.
    assert.equal(rows[0].n, 4)
  })
})

describe('openly licensed sources (TYL-45)', () => {
  const importAs = (p) =>
    as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [p])
      return rows[0].r
    })
  const publish = (sourceId) =>
    as('service_role', null, async () => {
      const { rows } = await db.query(
        'select publish_licensed_recipes($1) as n',
        [sourceId],
      )
      return rows[0].n
    })

  it('records the Wikibooks Cookbook with its license', async () => {
    const { rows } = await db.query(
      `select name, content_rights, crawl_enabled, license_name, license_url, attribution
       from recipe_sources where domain = 'en.wikibooks.org'`,
    )
    assert.deepEqual(rows[0], {
      name: 'Wikibooks Cookbook',
      content_rights: 'licensed',
      crawl_enabled: false,
      license_name: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'Wikibooks contributors',
    })
  })

  it('stores steps, then publishes recipes with ingredients and steps', async () => {
    const recipe = (title, steps) => ({
      source: { domain: 'en.wikibooks.org', name: 'Wikibooks Cookbook' },
      recipe: {
        source_url: `https://en.wikibooks.org/wiki/Cookbook:${title}`,
        title,
        instructions: steps,
      },
      ingredients: [
        {
          line_no: 0,
          raw_text: '1 cup red lentils',
          name: 'red lentils',
          candidates: ['red lentils'],
        },
      ],
    })
    const good = await importAs(recipe('Dal_Test', ['Simmer the lentils.']))
    const noSteps = await importAs(recipe('No_Steps_Test', []))
    const before = await as(
      'anon',
      null,
      async () =>
        (
          await db.query(
            'select count(*)::int as n from recipes where id = $1',
            [good.recipe_id],
          )
        ).rows[0].n,
    )
    assert.equal(before, 0, 'not public until published')

    const { rows: src } = await db.query(
      "select id from recipe_sources where domain = 'en.wikibooks.org'",
    )
    assert.equal(await publish(src[0].id), 1)
    const seen = await as('anon', null, async () => {
      const { rows } = await db.query(
        'select id, instructions from recipes where id = any($1)',
        [[good.recipe_id, noSteps.recipe_id]],
      )
      return rows
    })
    assert.deepEqual(seen, [
      { id: good.recipe_id, instructions: ['Simmer the lentils.'] },
    ])
  })

  it('refuses link-only sources, and anyone but the API', async () => {
    await db.query(
      `insert into recipe_sources (name, domain) values ('A blog', 'licensed-test-blog.example')`,
    )
    const { rows } = await db.query(
      "select id from recipe_sources where domain = 'licensed-test-blog.example'",
    )
    await assert.rejects(publish(rows[0].id), /can't be published/)
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query('select publish_licensed_recipes($1)', [rows[0].id]),
      ),
      /only callable by the API/,
    )
  })
})

describe('saving recipes from the browser', () => {
  const save = (user, id) =>
    as('authenticated', user, () =>
      db.query(
        'insert into user_saved_recipes (user_id, recipe_id) values ($1, $2)',
        [user, id],
      ),
    )

  it('saves public recipes and the user’s own', async () => {
    await save(BOB, await recipe('Saved public test', []))
    await save(
      ALICE,
      await recipe('Saved own test', [], {
        visibility: 'private',
        addedBy: ALICE,
      }),
    )
  })

  it('won’t save, and so can’t reveal, someone else’s private recipe', async () => {
    // Alice's private copy of a page from a site that blocks Sous.
    const secret = await recipe('Alice browser copy test', [], {
      visibility: 'private',
      addedBy: ALICE,
      url: 'https://blocked.example/alice-secret/',
    })
    await assert.rejects(save(BOB, secret), /row-level security/)
    const seen = await as('authenticated', BOB, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from recipes where id = $1',
        [secret],
      )
      return rows[0].n
    })
    assert.equal(seen, 0)
  })

  it('still lets the importer save fetched recipes awaiting review', async () => {
    const r = await as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipe($1) as r', [
        {
          added_by: BOB,
          source: { domain: 'review-blog.example' },
          recipe: {
            source_url: 'https://review-blog.example/x/',
            title: 'Pending',
          },
        },
      ])
      return rows[0].r
    })
    const seen = await as('authenticated', BOB, async () => {
      const { rows } = await db.query(
        'select count(*)::int as n from recipes where id = $1',
        [r.recipe_id],
      )
      return rows[0].n
    })
    assert.equal(seen, 1, 'readable through the user’s own saved row')
  })
})

describe('measurement equivalencies (TYL-79)', () => {
  const unitsOf = async (name) =>
    Object.fromEntries(
      (
        await db.query(
          `select u.unit, u.grams::float as grams from ingredient_units u
           join ingredients i on i.id = u.ingredient_id where i.name = $1`,
          [name],
        )
      ).rows.map((r) => [r.unit, r.grams]),
    )

  it('knows units that belong to one ingredient', async () => {
    const garlic = await unitsOf('garlic')
    assert.equal(garlic.clove, 3)
    assert.equal(garlic.head, 50)
    assert.equal((await unitsOf('butter')).stick, 113)
    assert.equal((await unitsOf('white bread')).slice, 29)
    const { rows } = await db.query(
      "select grams_per_each::float as each from ingredients where name = 'garlic'",
    )
    assert.equal(rows[0].each, 50, 'one garlic is a head')
  })

  it('sells herbs and scallions by the bunch', async () => {
    const { rows } = await db.query(
      `select name, package_quantity::float as qty, package_unit from ingredients
       where name in ('cilantro', 'scallions', 'celery') order by name`,
    )
    assert.deepEqual(
      rows.map((r) => [r.name, r.qty, r.package_unit]),
      [
        ['celery', 1, 'bunch'],
        ['cilantro', 1, 'bunch'],
        ['scallions', 1, 'bunch'],
      ],
    )
  })

  it('gives the API each ingredient’s units for pricing', async () => {
    const USER = '00000000-0000-0000-0000-0000000000f1'
    await db.query('insert into auth.users (id) values ($1)', [USER])
    const garlic = (
      await db.query("select id from ingredients where name = 'garlic'")
    ).rows[0].id
    const r = await recipe('Garlic test', [[garlic]])
    await as('authenticated', USER, () =>
      db.query("select add_to_meal_plan('2026-10-12', $1, 1)", [r]),
    )
    const inputs = await as(
      'service_role',
      null,
      async () =>
        (
          await db.query("select plan_cost_inputs($1, '2026-10-12') as r", [
            USER,
          ])
        ).rows[0].r,
    )
    assert.equal(inputs.ingredients[garlic].units.clove, 3)
  })

  it('is readable by anyone, like other catalog data', async () => {
    const n = await as(
      'anon',
      null,
      async () =>
        (await db.query('select count(*)::int as n from ingredient_units'))
          .rows[0].n,
    )
    assert.ok(n > 100)
  })
})

describe('bulk import', () => {
  const page = (slug, title) => ({
    source: { domain: 'bulk-test.example' },
    recipe: { source_url: `https://bulk-test.example/${slug}/`, title },
  })

  it('saves a batch and reports the ones that fail', async () => {
    const result = await as('service_role', null, async () => {
      const { rows } = await db.query('select import_recipes($1) as r', [
        JSON.stringify([
          page('a', 'Bulk A'),
          page('b', null),
          page('c', 'Bulk C'),
        ]),
      ])
      return rows[0].r
    })
    assert.equal(result.saved, 2)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].source_url, 'https://bulk-test.example/b/')
    const { rows } = await db.query(
      "select count(*)::int as n from recipes where source_url like 'https://bulk-test.example/%'",
    )
    assert.equal(rows[0].n, 2)
  })

  it('records each catalog recipe’s courses', async () => {
    await as('service_role', null, () =>
      db.query('select import_recipes($1)', [
        JSON.stringify([
          { ...page('d', 'Bulk D'), courses: ['dessert', 'not-a-course'] },
        ]),
      ]),
    )
    const { rows } = await db.query(
      "select courses from recipes where source_url = 'https://bulk-test.example/d/'",
    )
    assert.deepEqual(rows[0].courses, ['dessert'])
  })

  it('is only for the API, and only for reasonable batches', async () => {
    await assert.rejects(
      as('authenticated', ALICE, () =>
        db.query('select import_recipes($1)', [JSON.stringify([])]),
      ),
      /only callable by the API/,
    )
    await assert.rejects(
      as('service_role', null, () =>
        db.query('select import_recipes($1)', [
          JSON.stringify(
            Array.from({ length: 201 }, (_, i) => page(`x${i}`, 'X')),
          ),
        ]),
      ),
      /at most 200/,
    )
  })
})

describe('find: search by intent, ranked for the user (Find)', () => {
  const VEG = '00000000-0000-0000-0000-0000000000a7'
  const ids = {}
  const ing = async (name) =>
    (await db.query('select id from ingredients where name = $1', [name]))
      .rows[0].id

  // A public recipe with real amounts: [name, quantity, unit].
  async function dish(title, lines, extra = {}) {
    const { rows } = await db.query(
      `insert into recipes (title, source_url, status, visibility, total_minutes)
       values ($1, $2, 'active', 'public', $3) returning id`,
      [
        title,
        `https://find-test.example/${encodeURIComponent(title)}`,
        extra.minutes ?? null,
      ],
    )
    const id = rows[0].id
    for (const [n, [name, qty, unit]] of lines.entries()) {
      await db.query(
        `insert into recipe_ingredients (recipe_id, line_no, raw_text, ingredient_id, quantity, unit)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          n,
          `${qty} ${unit} ${name}`,
          name ? await ing(name) : null,
          qty,
          unit,
        ],
      )
    }
    await db.query('select refresh_recipe_diets($1)', [id])
    for (const c of extra.cuisines ?? []) {
      await db.query(
        'insert into recipe_cuisines (recipe_id, cuisine_slug) values ($1, $2)',
        [id, c],
      )
    }
    return id
  }

  const search = (q, user = VEG, limit = 20) =>
    as(
      'authenticated',
      user,
      async () =>
        (await db.query('select * from search_recipes($1, $2)', [q, limit]))
          .rows,
    )

  before(async () => {
    await db.query('insert into auth.users (id) values ($1)', [VEG])
    await db.query(
      "insert into user_diets (user_id, diet_slug) values ($1, 'vegetarian')",
      [VEG],
    )
    ids.frittata = await dish('Find Frittata', [
      ['eggs', 8, 'each'],
      ['cheddar cheese', 0.5, 'cup'],
    ])
    ids.cake = await dish(
      'Find Sponge Cake',
      [
        ['eggs', 2, 'each'],
        ['all-purpose flour', 2, 'cup'],
        ['sugar', 1.5, 'cup'],
      ],
      { minutes: 60 },
    )
    ids.chickenEggs = await dish('Find Chicken and Egg Rice', [
      ['chicken', 1, 'lb'],
      ['eggs', 2, 'each'],
    ])
    ids.mystery = await dish('Find Mystery Egg Pie', [
      ['eggs', 4, 'each'],
      [null, 1, 'cup'],
    ])
    ids.dal = await dish('Find Quick Dal', [['lentils', 1, 'cup']], {
      minutes: 25,
      cuisines: ['indian'],
    })
  })

  it('weighs each ingredient line', async () => {
    const { rows } = await db.query(
      'select grams::float from recipe_ingredients where recipe_id = $1 order by line_no',
      [ids.frittata],
    )
    assert.equal(rows[0].grams, 400) // 8 eggs × 50 g
    assert.ok(rows[1].grams > 50)
  })

  it('finds what features the ingredient, not just what mentions it', async () => {
    const titles = (await search('eggs')).map((r) => r.title)
    assert.deepEqual(
      titles.filter((t) => t.startsWith('Find ')),
      ['Find Frittata', 'Find Sponge Cake', 'Find Mystery Egg Pie'],
    )
  })

  it("leaves out recipes that break the user's diet, and puts unsure ones last", async () => {
    const rows = await search('eggs')
    assert.ok(!rows.some((r) => r.title === 'Find Chicken and Egg Rice'))
    const pie = rows.find((r) => r.title === 'Find Mystery Egg Pie')
    assert.equal(pie.fit, 'unknown')
    assert.ok(pie.why.includes('not every ingredient could be checked'))
    // Without rules, the chicken dish is there.
    const anyone = (await search('eggs', ALICE)).map((r) => r.title)
    assert.ok(anyone.includes('Find Chicken and Egg Rice'))
  })

  it('reads cuisines and time from the query', async () => {
    assert.deepEqual(
      (await search('quick indian')).map((r) => r.title),
      ['Find Quick Dal'],
    )
    assert.ok(
      !(await search('under 30 eggs')).some(
        (r) => r.title === 'Find Sponge Cake',
      ),
    )
  })

  it('searches titles with words it does not understand', async () => {
    assert.deepEqual(
      (await search('sponge')).map((r) => r.title),
      ['Find Sponge Cake'],
    )
  })

  it('sinks recipes with ingredients the user dislikes', async () => {
    const USER = '00000000-0000-0000-0000-0000000000a8'
    await db.query('insert into auth.users (id) values ($1)', [USER])
    await db.query(
      'insert into user_disliked_ingredients (user_id, ingredient_id) values ($1, $2)',
      [USER, await ing('cheddar cheese')],
    )
    const titles = (await search('eggs', USER))
      .map((r) => r.title)
      .filter((t) => t.startsWith('Find '))
    assert.equal(titles.at(-1), 'Find Frittata')
  })

  it('filters by course, and sinks sauces unless asked for', async () => {
    const sauce = await dish('Find Egg Sauce', [['eggs', 6, 'each']])
    const breakfast = await dish('Find Breakfast Hash', [
      ['eggs', 2, 'each'],
      ['potatoes', 2, 'each'],
    ])
    await db.query("update recipes set courses = '{sauce}' where id = $1", [
      sauce,
    ])
    await db.query("update recipes set courses = '{breakfast}' where id = $1", [
      breakfast,
    ])
    assert.deepEqual(
      (await search('breakfast eggs')).map((r) => r.title),
      ['Find Breakfast Hash'],
    )
    const eggs = (await search('eggs', ALICE)).map((r) => r.title)
    assert.ok(eggs.indexOf('Find Egg Sauce') > eggs.indexOf('Find Frittata'))
  })

  it('reads the query into parts', async () => {
    const { rows } = await db.query(
      "select * from read_search_query('Quick vegetarian Thai red lentils curry')",
    )
    const q = rows[0]
    assert.equal(q.max_minutes, 30)
    assert.deepEqual(q.diet_slugs, ['vegetarian'])
    assert.deepEqual(q.cuisine_slugs, ['thai'])
    assert.equal(q.ingredient_ids.length, 1)
    assert.equal(q.rest, 'curry')
    const { rows: d } = await db.query(
      "select course_slugs from read_search_query('easy desserts')",
    )
    assert.deepEqual(d[0].course_slugs, ['dessert'])
  })
})

describe('bought as (TYL-61)', () => {
  it('buys egg yolks as eggs, and lemon juice as lemons', async () => {
    const { rows } = await db.query(
      `select i.name, s.name as buy_as, i.buy_ratio::float as ratio from ingredients i
       join ingredients s on s.id = i.buy_as order by i.name`,
    )
    assert.deepEqual(
      rows.map((r) => [r.name, r.buy_as]),
      [
        ['egg whites', 'eggs'],
        ['egg yolks', 'eggs'],
        ['lemon juice', 'lemons'],
        ['lime juice', 'lime'],
      ],
    )
  })

  it('gives the API what yolks are bought as, with its prices', async () => {
    const USER = '00000000-0000-0000-0000-0000000000b1'
    await db.query('insert into auth.users (id) values ($1)', [USER])
    const yolks = (
      await db.query("select id from ingredients where name = 'egg yolks'")
    ).rows[0].id
    const eggs = (
      await db.query("select id from ingredients where name = 'eggs'")
    ).rows[0].id
    const r = await recipe('Yolk test custard', [[yolks]])
    await as('authenticated', USER, () =>
      db.query("select add_to_meal_plan('2026-10-12', $1, 1)", [r]),
    )
    const inputs = await as(
      'service_role',
      null,
      async () =>
        (
          await db.query("select plan_cost_inputs($1, '2026-10-12') as r", [
            USER,
          ])
        ).rows[0].r,
    )
    assert.equal(inputs.ingredients[yolks].buy_as, eggs)
    assert.ok(inputs.ingredients[eggs], 'eggs come along')
    assert.ok(
      inputs.prices.some((p) => p.ingredient_id === eggs),
      'with their prices',
    )
  })

  it("can't be bought as itself", async () => {
    await assert.rejects(
      db.query(
        "update ingredients set buy_as = id, buy_ratio = 1 where name = 'eggs'",
      ),
      /ingredients_buy_as/,
    )
  })
})
