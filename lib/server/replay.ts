// This module is eliminated by Vite's production constant folding.
// It enables UI QA against recorded official responses without weakening preview networking.
export async function replayData(){
 if(import.meta.env.DEV){return (await import('../../development-fixtures/us-api.json')).default as Record<string,any>;}
 return null;
}
