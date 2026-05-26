"use client";

import { useState } from "react";

type LogoutButtonProps = {
  className?: string;
};

export default function LogoutButton({ className = "secondary-link" }: LogoutButtonProps) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
      });
    } finally {
      window.location.href = "/";
    }
  }

  return (
    <button className={className} disabled={isLoggingOut} onClick={handleLogout} type="button">
      {isLoggingOut ? "正在退出..." : "退出登录"}
    </button>
  );
}
