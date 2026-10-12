-- What course a recipe is (TYL-45 / Find): main, side, soup, salad, dessert,
-- breakfast, bread, snack, drink or sauce. From the source's categories when
-- it has them (Wikibooks). Search filters on courses named in the query and
-- lets sauces and drinks sink when the query doesn't ask for them.
alter table public.recipes
  add column courses text[] not null default '{}'
    check (courses <@ array['main', 'side', 'soup', 'salad', 'dessert', 'breakfast',
                            'bread', 'snack', 'drink', 'sauce']);

-- Bulk loads now also record each catalog recipe's courses.
create or replace function public.import_recipes(p_recipes jsonb) returns jsonb
language plpgsql as $$
declare
  v_recipe jsonb;
  v_result jsonb;
  v_saved integer := 0;
  v_failed jsonb := '[]';
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'import_recipes is only callable by the API' using errcode = '42501';
  end if;
  if jsonb_typeof(p_recipes) <> 'array' or jsonb_array_length(p_recipes) > 200 then
    raise exception 'send an array of at most 200 recipes' using errcode = '22023';
  end if;
  for v_recipe in select value from jsonb_array_elements(p_recipes) loop
    begin
      v_result := public.import_recipe(v_recipe);
      if jsonb_typeof(v_recipe -> 'courses') = 'array' then
        update public.recipes set courses = array(
          select distinct c from jsonb_array_elements_text(v_recipe -> 'courses') c
          where c = any(array['main', 'side', 'soup', 'salad', 'dessert', 'breakfast',
                              'bread', 'snack', 'drink', 'sauce'])
        )
        where id = (v_result ->> 'recipe_id')::uuid and added_by is null;
      end if;
      v_saved := v_saved + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object(
        'source_url', v_recipe -> 'recipe' ->> 'source_url', 'error', sqlerrm
      );
    end;
  end loop;
  return jsonb_build_object('saved', v_saved, 'failed', v_failed);
end
$$;
