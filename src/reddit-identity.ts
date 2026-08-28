import type { Page } from "playwright-core";

const profileLabel = /view profile|переглянути профіль|переглянути профайл|посмотреть профиль/i;
const userMenuLabel = /user menu|expand user menu|open user menu|меню користувача|меню пользователя/i;

export function redditUsernameFromProfileHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\/user\/([A-Za-z0-9_-]{3,20})\/?$/i);
  return match?.[1];
}

async function visibleProfileUsername(page: Page): Promise<string | undefined> {
  const links = page.locator('a[href^="/user/"]');
  for (let i = 0; i < await links.count(); i += 1) {
    const link = links.nth(i);
    if (!await link.isVisible().catch(() => false)) continue;
    const text = (await link.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!profileLabel.test(text)) continue;
    const username = redditUsernameFromProfileHref(await link.getAttribute("href"));
    if (username) return username;
  }
  return undefined;
}

export async function detectRedditUsername(page: Page): Promise<string | undefined> {
  const alreadyVisible = await visibleProfileUsername(page);
  if (alreadyVisible) return alreadyVisible;

  const buttons = page.getByRole("button", { name: userMenuLabel });
  let menuButton;
  for (let i = 0; i < await buttons.count(); i += 1) {
    if (await buttons.nth(i).isVisible().catch(() => false)) {
      if (menuButton) return undefined;
      menuButton = buttons.nth(i);
    }
  }
  if (!menuButton) return undefined;

  await menuButton.click();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const username = await visibleProfileUsername(page);
      if (username) return username;
      if (attempt < 9) await page.waitForTimeout(100);
    }
    return undefined;
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}
