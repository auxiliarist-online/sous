// Runs every migration against PGlite (in-process Postgres) with a minimal
// stand-in for Supabase's auth schema, then checks diet tagging and RLS.
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { before, describe, it } from 'node:test'

const migrationsDir = new URL('../migrations/', import.meta.url)

const ALICE = '00000000-0000-0000-0000-00000000000a'
const BOB = '00000000-0000-0000-0000-00000000000b'

// The pieces of Supabase the migrations rely on.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
`

const GRANTS = `
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant all on all functions in schema public to anon, authenticated, service_role;
`

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
