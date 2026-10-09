import { SignUp } from '@clerk/nextjs';

// Same legacy #login overlay and appearance as sign-in (D-53).
export default function SignUpPage() {
  return (
    <div id="login" className="on">
      <SignUp
        appearance={{
          variables: { colorPrimary: '#BB5E1E', colorText: '#2B2118', borderRadius: '10px' },
        }}
      />
    </div>
  );
}
