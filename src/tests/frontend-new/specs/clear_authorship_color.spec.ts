import {expect, test} from "@playwright/test";
import {
  clearAuthorship,
  clearPadContent,
  getPadBody,
  goToNewPad,
  selectAllText,
  undoChanges,
  writeToPad
} from "../helper/padHelper";

test.beforeEach(async ({ page })=>{
  // create a new pad before each test run
  await goToNewPad(page);
})

test('clear authorship color', async ({page}) => {
  const padBody = await getPadBody(page);

  // type some text
  await clearPadContent(page);
  await writeToPad(page, "Hello");
  await expect(padBody.locator('div span').first()).toHaveAttribute('class', /author-/);

  // select all and clear authorship
  await padBody.click()
  await selectAllText(page);
  // Accept the confirm dialog triggered when whole document is selected
  page.on('dialog', dialog => dialog.accept());
  await clearAuthorship(page);

  // authorship should be cleared, user should not be disconnected
  await expect(padBody.locator('div').first()).not.toHaveAttribute('class', /author/, {timeout: 5000});
  await expect(page.locator('div.disconnected')).not.toBeVisible();
})


test("clearing authorship colors can be undone and redone", async function ({page}) {
  const innerPad = await getPadBody(page);
  const padText = "Hello"

  // type some text
  await clearPadContent(page);
  await writeToPad(page, padText);

  // get the first text element out of the inner iframe
  const firstDiv = innerPad.locator('div').nth(0)
  const firstSpan = innerPad.locator('div span').nth(0)
  expect(await firstSpan.getAttribute('class')).toContain('author');

  await firstDiv.focus()
  // Accept the confirm dialog triggered when there is no selection
  page.on('dialog', dialog => dialog.accept());
  await clearAuthorship(page);
  expect(await firstDiv.getAttribute('class')).not.toContain('author');

  // One Ctrl+Z must restore the original author colors without changing the text.
  await undoChanges(page);
  expect(await firstSpan.getAttribute('class')).toContain('author');
  expect(await firstDiv.textContent()).toBe(padText);

  // Ctrl+Y must redo the clear, removing the colors again without changing the text.
  await page.keyboard.down('Control');
  await page.keyboard.press('y');
  await page.keyboard.up('Control');
  expect(await firstSpan.getAttribute('class')).not.toContain('author');
  expect(await firstDiv.textContent()).toBe(padText);
});


test('clears authorship when first line has line attributes', async function ({page}) {
  // Make sure there is text with author info. The first line must have a line attribute.
  const padBody = await getPadBody(page);
  // Accept confirm dialogs before any action that might trigger one
  page.on('dialog', dialog => dialog.accept());
  await padBody.click()
  await clearPadContent(page);
  await writeToPad(page,'Hello')
  await page.locator('.buttonicon-insertunorderedlist').click({force: true});
  // Wait for the list attribute to be applied before checking authorship
  await page.waitForTimeout(500);
  await expect(padBody.locator('div span').first()).toHaveAttribute('class', /author-/);
  await padBody.click()
  await selectAllText(page);
  await clearAuthorship(page);
  // Wait longer for clear to propagate on list content
  await expect(padBody.locator('div span').first()).not.toHaveAttribute('class', /author-/, {timeout: 10000});
});
