import { useEffect, useState } from "react";

import { subscribeToast } from "../lib/toast";

export function Toast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => subscribeToast(setMessage), []);

  if (!message) return null;
  return <div className="toast">{message}</div>;
}
