const CACHE_NAME="centro-quant-markets-v1-1";
const CORE=[
  "./",
  "./index.html",
  "./styles.css?v=1.1.0",
  "./app.js?v=1.1.0",
  "./manifest.webmanifest"
];

self.addEventListener("install",event=>{
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE)).catch(()=>{})
  );
});

self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET") return;

  const url=new URL(req.url);
  const isSameOrigin=url.origin===self.location.origin;
  const isAppAsset=isSameOrigin && (
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/styles.css")
  );

  if(isAppAsset){
    event.respondWith((async()=>{
      try{
        const fresh=await fetch(req,{cache:"no-store"});
        const cache=await caches.open(CACHE_NAME);
        cache.put(req,fresh.clone());
        return fresh;
      }catch(e){
        const cached=await caches.match(req);
        if(cached) return cached;
        throw e;
      }
    })());
    return;
  }

  event.respondWith((async()=>{
    const cached=await caches.match(req);
    if(cached) return cached;
    try{
      const fresh=await fetch(req);
      if(isSameOrigin){
        const cache=await caches.open(CACHE_NAME);
        cache.put(req,fresh.clone());
      }
      return fresh;
    }catch(e){
      return cached || Response.error();
    }
  })());
});
