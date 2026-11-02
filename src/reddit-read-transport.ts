/** Safe fallback for GET-only Reddit readers. Never retry writes or rate limits. */
export function redditReadTransportFallback(error: unknown): boolean {
  const message=String(error instanceof Error?error.message:error);
  return /^(?:AUTH_REQUIRED|REDDIT_BROWSER_START_FAILED|BROWSER_START_FAILED):|Target page, context or browser has been closed|browserContext.cookies|Browser has been closed/i.test(message);
}
export async function withRedditReadFallback<T>(preferred:()=>Promise<T>,fallback:()=>Promise<T>,enabled:boolean):Promise<T> {
  if(!enabled)return fallback();
  try{return await preferred();}
  catch(error){if(!redditReadTransportFallback(error))throw error;return await fallback();}
}
