import AuthClient from "@/app/auth/AuthClient";

export default function LoginPage() {
  return <AuthClient initialMode="login" lockMode totalLogin />;
}
