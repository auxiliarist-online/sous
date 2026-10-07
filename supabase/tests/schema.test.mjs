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

  it('seeds baseline prices for every seeded ingredient', async () => {
    const { rows } = await db.query(`
      select (select count(*) from ingredients)::int as ingredients,
             (select count(*) from prices where source in ('baseline_bls', 'baseline_usda', 'seed'))::int as prices,
             (select count(*) from ingredients i
                where not exists (select 1 from prices p where p.ingredient_id = i.id))::int as unpriced
    `)
    assert.ok(rows[0].prices >= 100)
    assert.equal(rows[0].prices, rows[0].ingredients)
    assert.equal(rows[0].unpriced, 0)
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
        'insert into meal_plan_entries (meal_plan_id, recipe_id, servings) values ($1, $2, 2)',
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
      `insert into ingredients (name, contains, may_contain) values ('pesto', '{dairy}', '{tree_nut}')
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
