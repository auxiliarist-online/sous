// "Save to Sous": a bookmarklet that runs on a recipe page in the user's own
// browser, collects its schema.org JSON-LD, and opens Sous with it in the
// URL fragment (#import=...), where the user confirms the save. It sends
// nothing anywhere by itself.

/** Same limit as the API (MAX_LD_BLOCKS in apps/api/app/recipes/extract.py). */
export const MAX_LD_BLOCKS = 20

export function bookmarklet(origin: string): string {
  const code = `(()=>{
const ld=[...document.querySelectorAll('script[type="application/ld+json"]')]
.map(s=>s.textContent||'').filter(t=>/Recipe/.test(t)).slice(0,${MAX_LD_BLOCKS});
if(!ld.length){alert("Sous couldn't find a recipe on this page.");return}
const c=document.querySelector('link[rel="canonical"]');
const n=document.querySelector('meta[property="og:site_name"]');
const u=${JSON.stringify(origin)}+'/#import='+encodeURIComponent(JSON.stringify({
url:(c&&c.href)||location.href,site:(n&&n.getAttribute('content'))||null,ld}));
if(!window.open(u,'_blank'))location.href=u})()`
  return 'javascript:' + code.replace(/\n/g, '')
}
