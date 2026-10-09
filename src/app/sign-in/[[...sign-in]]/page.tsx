import { SignIn } from '@clerk/nextjs';

// Clerk UI is wrapped in the legacy #login overlay and themed through its appearance API, so legacy
// bare-element CSS rules do not need to know about Clerk's markup (docs/UI_PORT.md §1).
export default function SignInPage() {
  return (
    <div id="login" className="on">
      <SignIn
        appearance={{
          variables: { colorPrimary: '#BB5E1E', colorText: '#2B2118', borderRadius: '10px' },
        }}
      />
    </div>
  );
}
