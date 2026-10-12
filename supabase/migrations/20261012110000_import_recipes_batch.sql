-- Import many recipes in one call (bulk loads like the Wikibooks Cookbook):
-- one round trip per batch instead of per recipe. Each recipe goes through
-- import_recipe() as before; one that fails is reported and skipped, so a
-- bad page doesn't lose the rest of the batch.
create function public.import_recipes(p_recipes jsonb) returns jsonb
language plpgsql as $$
declare
  v_recipe jsonb;
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
      perform public.import_recipe(v_recipe);
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

revoke execute on function public.import_recipes(jsonb) from public, anon, authenticated;
grant execute on function public.import_recipes(jsonb) to service_role;
