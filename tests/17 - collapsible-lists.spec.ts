/* eslint-disable @typescript-eslint/no-unused-vars */
import { test, expect } from 'playwright-test-coverage';
import { Page } from '@playwright/test';
import { CONFIG_FILES, SIDEBAR_CLIP } from './constants';
import {
    haConfigRequest
} from './ha-services';
import { getSidebarListSelector, getSidebarListChildrenSelector } from './utilities';
import { SELECTORS } from './selectors';

const ADMIN_LIST = getSidebarListSelector('admin');
const ADMIN_LIST_CHILDREN = getSidebarListChildrenSelector('admin');

test.beforeAll(async ({ browser }) => {
    await haConfigRequest(browser, CONFIG_FILES.LISTS);
});

const pageVisit = async (page: Page): Promise<void> => {
    await page.goto('/');
    await expect(page.locator(SELECTORS.HA_SIDEBAR)).toBeVisible();
    await expect(page.locator(SELECTORS.HUI_VIEW)).toBeVisible();
    // await expect(page).toHaveScreenshot('sidebar-lists.png', {
    //     clip: SIDEBAR_CLIP
    // });
};

test('list should render expanded by default with all children visible', async ({ page }) => {
    await pageVisit(page);
    await expect(page.locator(ADMIN_LIST_CHILDREN)).toHaveCount(4);
});