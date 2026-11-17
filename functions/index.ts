// Page entry ("/") on Cloudflare Pages: the project's default address (cwrv3.pages.dev) redirects to the custom
// domain, so settings (stored per origin) live in one place. Only "/" runs this; assets are served without a
// Function call. Preview deployments (<hash>.cwrv3.pages.dev) are left alone for testing.
const CANONICAL = 'https://cwrv3.pytn.lol';
const DEFAULT_HOST = 'cwrv3.pages.dev';

export const onRequest = ({ request, next }: { request: Request; next: () => Promise<Response> }): Promise<Response> | Response => {
  const u = new URL(request.url);
  return u.hostname === DEFAULT_HOST ? Response.redirect(`${CANONICAL}/${u.search}`, 301) : next();
};
