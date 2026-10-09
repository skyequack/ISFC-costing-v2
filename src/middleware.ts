import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublic = createRouteMatcher(['/sign-in(.*)', '/api/health']);
const isApi = createRouteMatcher(['/api/(.*)']);

// Deny by default: every page needs a session. API routes answer 401 JSON themselves via withAuth.
export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req) || isApi(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
