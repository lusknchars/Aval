/*
 * Public demo build (`vite build --mode demo`, or VITE_DEMO=1): a static
 * console with no backend. The API layer answers from recordings and never
 * touches the network; pages that need a running service are left out.
 * See scripts/deploy-demo.sh.
 */
export const DEMO = import.meta.env.MODE === 'demo' || import.meta.env.VITE_DEMO === '1'

export const SITE_URL = 'https://aval-labs.vercel.app'
export const DOCS_URL = 'https://aval-labs.vercel.app/docs/'

/** Routes that need a running service; the demo hides them from the nav. */
export const DEMO_HIDDEN = new Set(['evaluate', 'deploy', 'system'])
