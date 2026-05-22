import AuthClient from "@/app/auth/AuthClient";

export default function RegisterPage() {
  return <AuthClient initialMode="register" lockMode />;
}
