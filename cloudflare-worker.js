const TARGET_BASE = "https://sites-testing.pplx.app/sites/proxy/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwcmVmaXgiOiJ3ZWIvZGlyZWN0LWZpbGVzL2NvbXB1dGVyL3NsYWNrXzE3NzE2MDg3ODYuNjE0NTc5L3dhbXNlYy8iLCJzaWQiOiJzbGFja18xNzcxNjA4Nzg2LjYxNDU3OSJ9.fyHHD6Sto7qAj7RogO6Ku9gMxKK-3UQQRuyHGAJ0CO4/web/direct-files/computer/slack_1771608786.614579/wamsec";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const targetUrl = TARGET_BASE + path + url.search + url.hash;

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
    });

    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
  },
};
