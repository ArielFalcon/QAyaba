/* qa-auth-setup-seed */
import { test as setup } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const authFile = ".auth/user.json";

/* Login once for the suite. Imports @playwright/test, not ./fixtures, so coverage,
   cleanup, and failure-capture do not run while the session is created. */
setup("authenticate", async ({ page }) => {
  const user = process.env.DEV_TEST_USER;
  const pass = process.env.DEV_TEST_PASS;
  if (!user || !pass) return;
  await page.goto("/");
  await page.getByLabel(/username|email|user/i).fill(user);
  await page.getByLabel(/^password$/i).fill(pass);
  await page.getByRole("button", { name: /log ?in|sign ?in|entrar/i }).click();
  /* Cookies are often set on the redirect after submit. Wait until the password
     form is gone before saving storageState. */
  const password = page.getByLabel(/^password$/i);
  try {
    await password.first().waitFor({ state: "hidden", timeout: 8000 });
  } catch {
    /* Still visible — the check below fails the seed so generation can rewrite it. */
  }
  if ((await password.count()) > 0 && (await password.first().isVisible())) {
    throw new Error("login did not leave the password form; rewrite e2e/auth.setup.ts for this app");
  }
  mkdirSync(dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});
