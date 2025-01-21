import { getPromisableResult } from 'get-promisable-result';
import {
    HAQuerySelector,
    HAQuerySelectorEvent,
    OnListenDetail,
    HAElement
} from 'home-assistant-query-selector';
import HomeAssistantJavaScriptTemplates, {
    HomeAssistantJavaScriptTemplatesRenderer,
    HassConnection
} from 'home-assistant-javascript-templates';
import { HomeAssistantStylesManager } from 'home-assistant-styles-manager';
import {
    HomeAsssistantExtended,
    HomeAssistantMain,
    HaMenuButton,
    Config,
    ConfigNewItem,
    ConfigOrder,
    ConfigOrderWithItem,
    PartialPanelResolver,
    Sidebar,
    SidebarMode,
    Match,
    SubscriberTemplate,
    ConfigListItem,
    isListItem,
    ConfigItem,
    isNewItem
} from '@types';
import {
    NAMESPACE,
    ELEMENT,
    SELECTOR,
    ATTRIBUTE,
    CUSTOM_SIDEBAR_CSS_VARIABLES,
    ITEM_OPTIONS_VARIABLES_MAP,
    SIDEBAR_OPTIONS_VARIABLES_MAP,
    KEY,
    CLASS,
    EVENT,
    CHECK_FOCUSED_SHADOW_ROOT,
    NODE_NAME,
    JS_TEMPLATE_REG,
    JINJA_TEMPLATE_REG,
    PROFILE_PATH,
    PROFILE_GENERAL_PATH,
    BLOCKED_PROPERTY,
    SIDEBAR_MODE_TO_DOCKED_SIDEBAR,
    MAX_ATTEMPTS,
    RETRY_DELAY
} from '@constants';
import {
    logVersionToConsole,
    getConfig,
    flushPromise,
    getTemplateWithPartials
} from '@utilities';
import * as STYLES from '@styles';
import { fetchConfig } from '@fetchers/json';

class CustomSidebar {

    constructor() {

        const selector = new HAQuerySelector();

        selector.addEventListener(
            HAQuerySelectorEvent.ON_LISTEN,
            (event: CustomEvent<OnListenDetail>) => {
                this._homeAssistant = event.detail.HOME_ASSISTANT;
                this._main = event.detail.HOME_ASSISTANT_MAIN;
                this._haDrawer = event.detail.HA_DRAWER;
                this._sidebar = event.detail.HA_SIDEBAR;
                this._partialPanelResolver = event.detail.PARTIAL_PANEL_RESOLVER;
            },
            {
                once: true
            }
        );

        selector.addEventListener(
            HAQuerySelectorEvent.ON_PANEL_LOAD,
            this._panelLoaded.bind(this)
        );

        selector.listen();

        this._styleManager = new HomeAssistantStylesManager({
            prefix: NAMESPACE,
            namespace: NAMESPACE,
            throwWarnings: false
        });

        this._items = [];
        this._sidebarScroll = 0;
        this._isSidebarEditable = undefined;
        this._itemTouchedBinded = this._itemTouched.bind(this);
        this._mouseEnterBinded = this._mouseEnter.bind(this);
        this._mouseLeaveBinded = this._mouseLeave.bind(this);
        this._configPromise = fetchConfig();
        this._process();
    }

    private _configPromise: Promise<Config>;
    private _config: Config;
    private _homeAssistant: HAElement;
    private _main: HAElement;
    private _haDrawer: HAElement;
    private _ha: HomeAsssistantExtended;
    private _partialPanelResolver: HAElement;
    private _sidebar: HAElement;
    private _sidebarScroll: number;
    private _isSidebarEditable: boolean | undefined;
    private _renderer: HomeAssistantJavaScriptTemplatesRenderer;
    private _styleManager: HomeAssistantStylesManager;
    private _items: HTMLElement[];
    private _itemTouchedBinded: () => Promise<void>;
    private _mouseEnterBinded: (event: MouseEvent) => void;
    private _mouseLeaveBinded: () => void;

    private async _getConfig(): Promise<void> {
        this._config = await this._configPromise
            .then((config: Config) => {
                return getConfig(
                    this._ha.hass.user,
                    navigator.userAgent.toLowerCase(),
                    config
                );
            });
    }

    private async _getElements(): Promise<[HTMLElement, NodeListOf<HTMLAnchorElement>, HTMLElement]> {
        const promisableResultOptions = {
            retries: MAX_ATTEMPTS,
            delay: RETRY_DELAY,
            shouldReject: false
        };
        const paperListBox = (await this._sidebar.selector.$.query(ELEMENT.PAPER_LISTBOX).element) as HTMLElement;
        const spacer = await getPromisableResult<HTMLElement>(
            () => paperListBox.querySelector<HTMLElement>(`:scope > ${SELECTOR.SPACER}`),
            (spacer: HTMLElement): boolean => !! spacer,
            promisableResultOptions
        );
        const items = await getPromisableResult<NodeListOf<HTMLAnchorElement>>(
            () => paperListBox.querySelectorAll<HTMLAnchorElement>(`:scope > ${SELECTOR.ITEM}, :scope > a[href]`),
            (elements: NodeListOf<HTMLAnchorElement>): boolean => {
                return Array.from(elements).every((element: HTMLAnchorElement): boolean => {
                    const text = element.querySelector<HTMLElement>(SELECTOR.ITEM_TEXT).innerText.trim();
                    return text.length > 0;
                });
            },
            promisableResultOptions
        );
        return [paperListBox, items, spacer];
    }

    private _hideAnchor(anchor: HTMLElement, hide: boolean): void {
        if (hide) {
            anchor.style.display = 'none';
        } else {
            anchor.style.removeProperty('display');
        }
    }

    private _buildNewItem(configItem: ConfigNewItem): HTMLAnchorElement {

        const a = document.createElement('a');
            a.href = configItem.href;
            a.target = configItem.target || '';
        a.tabIndex = -1;
        a.classList.add(CLASS.SIDEBAR_ITEM);
        a.setAttribute(ATTRIBUTE.ROLE, 'option');
        a.setAttribute(ATTRIBUTE.PANEL, configItem.item.toLowerCase().replace(/\s+/, '-'));
        

        a.setAttribute(ATTRIBUTE.ARIA_SELECTED, 'false');

        a.innerHTML = `
            <paper-icon-item
                tabindex="0"
                ${ATTRIBUTE.ROLE}="option"
                ${ATTRIBUTE.ARIA_DISABLED}="false">
                <span class="${CLASS.NOTIFICATIONS_BADGE} ${CLASS.NOTIFICATIONS_BADGE_COLLAPSED}"></span>
                <span class="item-text">
                    ${ configItem.item }
                </span>
              </paper-icon-item>
        `.trim();

        return a;
    }

    private _buildListItem(topLevelElement: HTMLElement, children: ConfigOrder[], collapsed?: boolean): HTMLDivElement {
        const container = document.createElement('div');
        container.className = CLASS.SIDEBAR_LIST;
        container.classList.add(CLASS.SIDEBAR_ITEM);
        container.appendChild(topLevelElement);
        const childrenContainer = document.createElement('div');
        childrenContainer.className = CLASS.SIDEBAR_LIST_CHILDREN;
        container.appendChild(childrenContainer);
        for (const child of children) {
            if(!!child)
                childrenContainer.appendChild(this.processConfigItem(child));
            else
                console.warn(topLevelElement, "Child of list item is undefined");
        }
        return container;
    }

    private async _getTemplateString(template: unknown): Promise<string> {
        let rendered = '';
        if (
            template instanceof Promise ||
            typeof template === 'string' ||
            (
                typeof template === 'number' &&
                !Number.isNaN(template)
            ) ||
            typeof template === 'boolean' ||
            typeof template === 'object'
        ) {
            if (typeof template === 'string') {
                rendered = template.trim();
            } else if (
                typeof template === 'number' ||
                typeof template === 'boolean'
            ) {
                rendered = template.toString();
            } else if (template instanceof Promise) {
                const result = await template;
                rendered = await this._getTemplateString(result);
            } else {
                rendered = JSON.stringify(template);
            }
        }
        return rendered;
    }

    private _subscribeTitle(): void {
        this._sidebar
            .selector
            .$
            .query(SELECTOR.TITLE)
            .element
            .then((titleElement: HTMLElement) => {
                if (this._config.title) {
                    this._subscribeTemplate(
                        this._config.title,
                        (rendered: string) => {
                            titleElement.innerHTML = rendered;
                        }
                    );
                }
                if (this._config.subtitle) {
                    this._subscribeTemplate(
                        this._config.subtitle,
                        (rendered: string) => {
                            titleElement.dataset.subtitle = rendered;
                        }
                    );
                }
            });
    }

    private _subscribeSideBarEdition(): void {

        const sidebarEditListener = (event: CustomEvent): void => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        const unblockSidebar = (homeAssistantMain: Element, menu: Element) => {
            homeAssistantMain.removeEventListener(EVENT.HASS_EDIT_SIDEBAR, sidebarEditListener, true);
            menu.removeAttribute(BLOCKED_PROPERTY);
        };

        const blockSidebar = (homeAssistantMain: Element, menu: Element) => {
            homeAssistantMain.removeEventListener(EVENT.HASS_EDIT_SIDEBAR, sidebarEditListener, true);
            homeAssistantMain.addEventListener(EVENT.HASS_EDIT_SIDEBAR, sidebarEditListener, true);
            menu.setAttribute(BLOCKED_PROPERTY, '');
        };

        // Apply sidebar edit blocker
        Promise.all([
            this._main.element,
            this._sidebar.selector.$.query(SELECTOR.MENU).element
        ]).then(([homeAssistantMain, menu]) => {
            if (typeof this._config.sidebar_editable === 'boolean') {
                this._isSidebarEditable = this._config.sidebar_editable;
                if (!this._isSidebarEditable) {
                    blockSidebar(homeAssistantMain, menu);
                }
            }
            if (typeof this._config.sidebar_editable === 'string') {
                this._subscribeTemplate(
                    this._config.sidebar_editable,
                    (rendered: string) => {
                        if (rendered === 'true' || rendered === 'false') {
                            this._isSidebarEditable = !(rendered === 'false');
                            if (this._isSidebarEditable) {
                                unblockSidebar(homeAssistantMain, menu);
                            } else {
                                blockSidebar(homeAssistantMain, menu);
                            }
                        } else {
                            this._isSidebarEditable = undefined;
                            unblockSidebar(homeAssistantMain, menu);
                        }
                        this._checkProfileEditableButton();
                    }
                );
            }
        });

    }

    private _subscribeName(element: HTMLElement, name: string): void {
        const itemText = element.querySelector<HTMLElement>(SELECTOR.ITEM_TEXT);
        this._subscribeTemplate(
            name,
            (rendered: string): void => {
                itemText.innerHTML = rendered;
            }
        );
    }

    private _subscribeIcon(element: HTMLElement, icon: string): void {
        this._subscribeTemplate(
            icon,
            (rendered: string): void => {
                let haIcon = element.querySelector(ELEMENT.HA_ICON);
                if (!haIcon) {
                    haIcon = document.createElement(ELEMENT.HA_ICON);
                    haIcon.setAttribute('slot', 'item-icon');
                    const haSvgIcon = element.querySelector(ELEMENT.HA_SVG_ICON);
                    if (haSvgIcon) {
                        haSvgIcon.replaceWith(haIcon);
                    } else {
                        element.querySelector(ELEMENT.PAPER_ICON_ITEM).prepend(haIcon);
                    }
                }
                haIcon.setAttribute('icon', rendered);
            }
        );
    }

    private _subscribeInfo(element: HTMLElement, info: string): void {
        const textElement = element.querySelector<HTMLElement>(SELECTOR.ITEM_TEXT);
        this._subscribeTemplate(
            info,
            (rendered: string): void => {
                textElement.dataset.info = rendered;
            }
        );
    }

    private _subscribeNotification(element: HTMLElement, notification: string): void {
        let badge = element.querySelector(`${SELECTOR.NOTIFICATION_BADGE}:not(${SELECTOR.NOTIFICATIONS_BADGE_COLLAPSED})`);
        let badgeCollapsed = element.querySelector(SELECTOR.NOTIFICATIONS_BADGE_COLLAPSED);
        if (!badge) {
            badge = document.createElement('span');
            badge.classList.add(CLASS.NOTIFICATIONS_BADGE);
            element
                .querySelector(ELEMENT.PAPER_ICON_ITEM)
                .append(badge);
        }
        if (!badgeCollapsed) {
            badgeCollapsed = document.createElement('span');
            badgeCollapsed.classList.add(CLASS.NOTIFICATIONS_BADGE, CLASS.NOTIFICATIONS_BADGE_COLLAPSED);
            element
                .querySelector(`${ELEMENT.HA_SVG_ICON}, ${ELEMENT.HA_ICON}`)
                .after(badgeCollapsed);
        }

        const callback = (rendered: string): void => {
            if (rendered.length) {
                badge.innerHTML = rendered;
                badgeCollapsed.innerHTML = rendered;
                element.setAttribute(ATTRIBUTE.WITH_NOTIFICATION, 'true');
            } else {
                badge.innerHTML = '';
                badgeCollapsed.innerHTML = '';
                element.removeAttribute(ATTRIBUTE.WITH_NOTIFICATION);
            }
        };

        this._subscribeTemplate(notification, callback);

    }

    private _subscribeHide(element: HTMLElement, hide: boolean | string) {
        if (typeof hide === 'boolean') {
            this._hideAnchor(element, hide);
        } else {
            this._subscribeTemplate(
                hide,
                (rendered: string): void => {
                    this._hideAnchor(
                        element,
                        rendered === 'true'
                    );
                }
            );
        }
    }

    private _subscribeTemplateColorChanges<T, K extends keyof T>(
        config: T,
        element: HTMLElement,
        dictionary: [K, string][]
    ): void {
        dictionary.forEach(([option, cssVariable]) => {
            if (config[option]) {
                this._subscribeTemplate(
                    config[option] as string,
                    (rendered: string): void => {
                        element.style.setProperty(
                            cssVariable,
                            rendered
                        );
                    }
                );
            }
        });
    }

    private _subscribeTemplate(template: string, callback: (rendered: string) => void): void {
        if (JS_TEMPLATE_REG.test(template)) {
            this._createJsTemplateSubscription(
                template.replace(JS_TEMPLATE_REG, '$1'),
                callback
            );
        } else if (JINJA_TEMPLATE_REG.test(template)) {
            this._createJinjaTemplateSubscription(
                template,
                callback
            );
        } else {
            this._getTemplateString(template)
                .then((result: string) => {
                    callback(result);
                });
        }
    }

    private _createJsTemplateSubscription(
        template: string,
        callback: (result: string) => void
    ): void {
        this._renderer.trackTemplate(
            getTemplateWithPartials(
                template,
                this._config.partials
            ),
            (result: unknown): void => {
                this._getTemplateString(result)
                    .then((templateResult: string) => {
                        callback(templateResult);
                    });
            }
        );

    }

    private _createJinjaTemplateSubscription(
        template: string,
        callback?: (rendered: string) => void
    ): void {
        window.hassConnection.then((hassConnection: HassConnection): void => {
            hassConnection.conn.subscribeMessage<SubscriberTemplate>(
                (message: SubscriberTemplate): void => {
                    callback(`${message.result}`);
                },
                {
                    type: EVENT.RENDER_TEMPLATE,
                    template: getTemplateWithPartials(
                        template,
                        this._config.partials
                    ),
                    variables: {
                        user_name: this._ha.hass.user.name,
                        user_is_admin: this._ha.hass.user.is_admin,
                        user_is_owner: this._ha.hass.user.is_owner,
                        user_agent: window.navigator.userAgent,
                        ...(this._config.jinja_variables)
                    }
                }
            );
        });
    }

    private _focusItem(activeIndex: number, forward: boolean, focusPaperItem: boolean): void {

        const length = this._items.length;
        const noneDisplay = 'none';
        let focusIndex = 0;

        if (forward) {
            const start = activeIndex + 1;
            const end = start + length;
            for (let i = start; i < end; i++) {
                const index = i > length - 1
                    ? i - length
                    : i;
                if (this._items[index].style.display !== noneDisplay) {
                    focusIndex = index;
                    break;
                }
            }
        } else {
            const start = activeIndex - 1;
            const end = start - length;
            for (let i = start; i > end; i--) {
                const index = i < 0
                    ? length + i
                    : i;
                if (this._items[index].style.display !== noneDisplay) {
                    focusIndex = index;
                    break;
                }
            }
        }

        if (focusPaperItem) {
            const paperItem = this._items[focusIndex].querySelector<HTMLElement>(ELEMENT.PAPER_ICON_ITEM);
            paperItem.focus();
        } else {
            this._items[focusIndex].focus();
            this._items[focusIndex].tabIndex = 0;
        }

    }

    private _focusItemByKeyboard(paperListBox: HTMLElement, forward: boolean): void {

        const activeAnchor = paperListBox.querySelector<HTMLAnchorElement>(
            `
                ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}:not(.${CLASS.IRON_SELECTED}):focus,
                ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}:focus,
                ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}:has(> ${ELEMENT.PAPER_ICON_ITEM}:focus)
            `
        );

        let activeIndex = 0;

        this._items.forEach((anchor: HTMLAnchorElement, index: number): void => {
            if (anchor === activeAnchor) {
                activeIndex = index;
            }
            anchor.tabIndex = -1;
        });

        this._focusItem(activeIndex, forward, false);

    }

    private _focusItemByTab(sidebarShadowRoot: ShadowRoot, element: HTMLElement, forward: boolean): void {

        if (element.nodeName === NODE_NAME.A) {

            const anchor = element as HTMLAnchorElement;
            const activeIndex = this._items.indexOf(anchor);
            const lastIndex = this._items.length - 1;

            if (
                (forward && activeIndex < lastIndex) ||
                (!forward && activeIndex > 0)
            ) {

                this._focusItem(activeIndex, forward, true);

            } else {

                const element = forward
                    ? sidebarShadowRoot.querySelector<HTMLElement>(SELECTOR.SIDEBAR_NOTIFICATIONS)
                    : sidebarShadowRoot.querySelector<HTMLElement>(ELEMENT.HA_ICON_BUTTON);
                element.focus();

            }

        } else {
            if (forward) {
                const profile = sidebarShadowRoot.querySelector<HTMLElement>(`${SELECTOR.PROFILE} > ${ELEMENT.PAPER_ICON_ITEM}`);
                profile.focus();
            } else {
                this._focusItem(0, forward, true);
            }
        }

    }
    private _getActivePaperIconElement(root: Document | ShadowRoot = document): Element | null {
        const activeEl = root.activeElement;
        if (activeEl) {
            if (
                activeEl instanceof HTMLElement &&
                (
                    activeEl.nodeName === NODE_NAME.PAPER_ICON_ITEM ||
                    (
                        activeEl.nodeName === NODE_NAME.A &&
                        activeEl.getAttribute('role') === 'option'
                    )
                )
            ) {
                return activeEl;
            }
            return activeEl.shadowRoot && CHECK_FOCUSED_SHADOW_ROOT.includes(activeEl.nodeName)
                ? this._getActivePaperIconElement(activeEl.shadowRoot)
                : null;
        }
        // In theory, activeElement could be null
        // but this is hard to reproduce during the tests
        // because there is always an element focused (e.g. the body)
        // So excluding this from the coverage
        /* istanbul ignore next */
        return null;
    }

    private _processSidebar(): void {

        // Process Home Assistant Main and Partial Panel Resolver
        Promise.all([
            this._main.element,
            this._partialPanelResolver.element
        ]).then(([homeAssistantMain, partialPanelResolver]: [HomeAssistantMain, PartialPanelResolver]) => {

            const sidebarMode = this._config.sidebar_mode;
            const mql = matchMedia('(max-width: 870px)');

            if (sidebarMode) {

                homeAssistantMain.hass.dockedSidebar = SIDEBAR_MODE_TO_DOCKED_SIDEBAR[sidebarMode];

                const checkForNarrow = async (isNarrow: boolean): Promise<void> => {
                    if (sidebarMode !== SidebarMode.HIDDEN) {
                        await flushPromise();
                        homeAssistantMain.narrow = false;
                        await flushPromise();
                        partialPanelResolver.narrow = isNarrow;
                        await flushPromise();
                        if (isNarrow) {
                            const haMenuButton = await this._partialPanelResolver.selector.query(SELECTOR.HA_MENU_BUTTON).element as HaMenuButton;
                            haMenuButton.narrow = false;
                        }
                    }
                };

                mql.addEventListener('change', (event: MediaQueryListEvent): void => {
                    checkForNarrow(event.matches);
                });

                checkForNarrow(mql.matches);
            }

        });

        // Process sidebar
        Promise.all([
            this._haDrawer.selector.$.query(SELECTOR.MC_DRAWER).element,
            this._sidebar.element,
            this._sidebar.selector.$.element,
            this._sidebar.selector.$.query(ELEMENT.PAPER_LISTBOX).element
        ]).then(([mcDrawer, sidebar, sideBarShadowRoot, paperListBox]: [HTMLElement, HTMLElement, ShadowRoot, HTMLElement]) => {

            this._subscribeTemplateColorChanges(
                this._config,
                sidebar,
                SIDEBAR_OPTIONS_VARIABLES_MAP
            );

            this._subscribeTemplateColorChanges(
                this._config,
                mcDrawer,
                [
                    ['sidebar_border_color',    CUSTOM_SIDEBAR_CSS_VARIABLES.BORDER_COLOR]
                ]
            );

            paperListBox.addEventListener(EVENT.KEYDOWN, (event: KeyboardEvent) => {
                if (
                    event.key === KEY.ARROW_DOWN ||
                    event.key === KEY.ARROW_UP
                ) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    this._focusItemByKeyboard(paperListBox, event.key === KEY.ARROW_DOWN);
                }
            }, true);

            window.addEventListener(EVENT.KEYDOWN, (event: KeyboardEvent) => {
                if (
                    event.key === KEY.TAB
                ) {
                    const activePaperItem = this._getActivePaperIconElement();
                    if (activePaperItem) {
                        if (activePaperItem.nodeName === NODE_NAME.PAPER_ICON_ITEM) {
                            const parentElement = activePaperItem.parentElement as HTMLElement;
                            if (parentElement.getAttribute(ATTRIBUTE.HREF) !== PROFILE_PATH) {
                                event.preventDefault();
                                event.stopImmediatePropagation();
                                this._focusItemByTab(sideBarShadowRoot, parentElement, !event.shiftKey);
                            }
                        } else if (activePaperItem.getAttribute(ATTRIBUTE.HREF) !== PROFILE_PATH) {
                            event.preventDefault();
                            event.stopImmediatePropagation();
                            this._focusItemByTab(sideBarShadowRoot, activePaperItem as HTMLElement, !event.shiftKey);
                        }
                    }
                }
            }, true);

            this._styleManager.addStyle(
                STYLES.SIDEBAR_BORDER_COLOR,
                mcDrawer
            );

            this._styleManager.addStyle(
                [
                    STYLES.FUNCTIONALITY,
                    STYLES.TITLE_COLOR,
                    STYLES.SUBTITLE_COLOR,
                    STYLES.SIDEBAR_BUTTON_COLOR,
                    STYLES.SIDEBAR_BACKGROUND,
                    STYLES.MENU_BACKGROUND_DIVIDER_TOP_COLOR,
                    STYLES.DIVIDER_BOTTOM_COLOR_DIVIDER_COLOR,
                    STYLES.SCROLL_THUMB_COLOR,
                    STYLES.SIDEBAR_EDITABLE,
                    STYLES.ITEM_BACKGROUND,
                    STYLES.ITEM_BACKGROUND_HOVER,
                    STYLES.ICON_COLOR,
                    STYLES.ICON_COLOR_SELECTED,
                    STYLES.ICON_COLOR_HOVER,
                    STYLES.TEXT_COLOR,
                    STYLES.TEXT_COLOR_SELECTED,
                    STYLES.TEXT_COLOR_HOVER,
                    STYLES.SELECTION_BACKGROUND_SELECTION_OPACITY,
                    STYLES.INFO_COLOR,
                    STYLES.INFO_COLOR_SELECTED,
                    STYLES.INFO_COLOR_HOVER,
                    STYLES.NOTIFICATION_COLOR_SELECTED_NOTIFICATION_TEXT_COLOR_SELECTED,
                    STYLES.NOTIFICATION_COLOR_HOVER_NOTIFICATION_TEXT_COLOR_HOVER,
                    STYLES.LIST_CHILDREN_STYLES,
                    this._config.styles || ''
                ],
                sideBarShadowRoot
            );

        });

    }

    private _rearrange(): void {
        this._getElements()
            .then((elements) => {

                const { order, hide_all } = this._config;
                const [paperListBox, items, spacer] = elements;


                this._items = Array.from(items);

                if (hide_all) {
                    this._items.forEach((element: HTMLAnchorElement): void => {
                        this._hideAnchor(element, true);
                    });
                }

                this.processConfig().forEach((element: HTMLElement): void => { 

                    paperListBox.appendChild(element);
                });

                this._items.sort(
                    (
                        linkA: HTMLAnchorElement,
                        linkB: HTMLAnchorElement
                    ): number => +linkA.style.order - +linkB.style.order
                );

                this._panelLoaded();

            });
    }

    private getConfigItems(): ConfigOrderWithItem[] {
        const { order, hide_all } = this._config;
        const matched: Set<Element> = new Set();
        return order.map((orderItem: ConfigOrder): ConfigOrderWithItem => this._getConfigOrderWithItem(orderItem, matched));
    }

    private processConfig(): HTMLElement[] {
        let orderIndex = 0;
        let crossedBottom = false;
        const configItems = this.getConfigItems();
        
        const sidebarElements: HTMLElement[] = [];
        
        configItems.forEach((item) => {
            if (item)
                sidebarElements.push(this.processConfigItem(item))
        });

        if (configItems.length) {
            // processBottom();
        }

        this._configPromise
            .then((config: Config) => {
                this._config = getConfig(
                    this._ha.hass.user,
                    navigator.userAgent.toLowerCase(),
                    config
                );
            });

        return sidebarElements;
    }

    private _getConfigOrderWithItem(orderItem: ConfigOrder, matched: Set<Element>): ConfigOrderWithItem {
        const { item, match, exact, new_item } = orderItem;
        let element = undefined;
        if (!new_item && !isListItem(orderItem)) {
            element =  this._items.find((element: Element): boolean => {
                const itemLowerCase = item.toLocaleLowerCase();
                const text = match === Match.DATA_PANEL
                    ? element.getAttribute(ATTRIBUTE.PANEL)
                    : (
                        match === Match.HREF
                            ? element.getAttribute(ATTRIBUTE.HREF)
                            : element.querySelector<HTMLElement>(SELECTOR.ITEM_TEXT).innerText.trim()
                    );

                const matchText = (
                    (!!exact && item === text) ||
                    // for non-admins, data-panel is not present in the config item
                    // due to this, text will be undefined in those cases
                    // as the tests run against an admin account, this cannot be covered
                    /* istanbul ignore next */
                    (!exact && !!text?.toLowerCase().includes(itemLowerCase))
                );

                if (matchText) {

                    if (matched.has(element)) {
                        return false;
                    } else {
                        matched.add(element);
                        return true;
                    }
                }
                return false;
            });
        }
        if (element) {
            element.setAttribute(ATTRIBUTE.PROCESSED, 'true');
            element.classList.add(CLASS.SIDEBAR_ITEM);
        }
        if (isListItem(orderItem)) {
            orderItem.children = orderItem.children.map((child: ConfigOrder): ConfigOrderWithItem => this._getConfigOrderWithItem(child, matched));
        }
        if (new_item || isListItem(orderItem) || element) {
            return {
                ...orderItem,
                element
            };
        }
        if (!new_item && !element) {
            console.warn(`${NAMESPACE}: you have an order item in your configuration that didn't match any sidebar item: "${item}"`);
        }
        return null;
    }

        
    // private processBottom(): void {
    //     if (!crossedBottom) {
    //         this._items.forEach((element: HTMLElement) => {
    //             if (!element.hasAttribute(ATTRIBUTE.PROCESSED)) {
    //                 element.style.order = `${orderIndex}`;
    //             }
    //         });
    //         orderIndex ++;
    //         (spacer as HTMLDivElement).style.order = `${orderIndex}`;
    //         orderIndex ++;
    //         crossedBottom = true;
    //     }
    // }

    private processConfigItem(orderItem: ConfigOrderWithItem): HTMLElement {
        if (orderItem.bottom) {
            // processBottom();
        }

        if (isListItem(orderItem)) {
            const topLevelElement = document.createElement('paper-icon-item');
            const topLevelIcon = document.createElement(ELEMENT.HA_ICON);
            topLevelIcon.setAttribute('icon', orderItem.icon);
            topLevelIcon.setAttribute('slot', 'item-icon');
            topLevelElement.appendChild(topLevelIcon);
            topLevelElement.setAttribute(ATTRIBUTE.PROCESSED, 'true');
            topLevelElement.classList.add(CLASS.SIDEBAR_LIST_PARENT);

            const topLevelText = document.createElement('span');
            topLevelText.innerHTML = orderItem.item;
            topLevelElement.appendChild(topLevelText);

            const expanderIcon = document.createElement(ELEMENT.HA_ICON);
            expanderIcon.className = CLASS.SIDEBAR_LIST_COLLAPSE_ICON;
            expanderIcon.setAttribute('icon', orderItem.collapsed ? 'mdi:chevron-down' : 'mdi:chevron-up');
            topLevelElement.appendChild(expanderIcon);
            topLevelElement.setAttribute(ATTRIBUTE.ARIA_EXPANDED, !orderItem.collapsed ? 'true' : 'false');
            const listItem = this._buildListItem(topLevelElement, orderItem.children, orderItem.collapsed);
            listItem.setAttribute(ATTRIBUTE.PROCESSED, 'true'); 
            orderItem.element = listItem;

            const computeVisibleChildren = (element: HTMLElement): number => {
                const childrenList = <HTMLElement>element.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
                let visibleChildren = 0;
                for (const child of Array.from(childrenList.children)) {
                    if ((<HTMLElement>child).style.display !== 'none')
                        visibleChildren++;
                    if (child.querySelector(`[${ATTRIBUTE.ARIA_EXPANDED}=true]`)) {
                        const nestedList = child.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
                        for (const nestedChild of Array.from(nestedList.children)) {
                            if ((<HTMLElement>nestedChild).style.display !== 'none')
                                visibleChildren++;
                        }
                    }
                }
                return visibleChildren;
            };
            const SIDEBAR_EXPAND_ANIMATION_TIME_PER_CHILD = 75;
            const ITEM_HEIGHT = 48;
            
            const childrenList = <HTMLElement>orderItem.element.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
            childrenList.style.maxHeight = !!orderItem.collapsed ? '0' : (computeVisibleChildren(orderItem.element) * 48) + 'px'; // TODO hardcoded 48

            topLevelElement.addEventListener('click', () => {
                const expanderIcon = orderItem.element.querySelector(`.${CLASS.SIDEBAR_LIST_COLLAPSE_ICON}`);
                const childrenList = <HTMLElement>orderItem.element.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
                const isOpening = childrenList.style.maxHeight === '0' || childrenList.style.maxHeight === '0px';
                const visibleChildren = computeVisibleChildren(orderItem.element);
                const scrollHeight = visibleChildren * ITEM_HEIGHT;
                const transitionTime = visibleChildren * SIDEBAR_EXPAND_ANIMATION_TIME_PER_CHILD;
                childrenList.style.maxHeight = isOpening ? `${scrollHeight}px` : '0';
                childrenList.style.transition = `max-height ${transitionTime}ms ease-in-out`,
                expanderIcon.setAttribute('icon', isOpening ? 'mdi:chevron-up' : 'mdi:chevron-down');
                topLevelElement.setAttribute(ATTRIBUTE.ARIA_EXPANDED, isOpening ? 'true' : 'false');
                if (isOpening) {
                    setTimeout(() => childrenList.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);
                    const parentList = <HTMLElement>topLevelElement.closest(SELECTOR.SIDEBAR_LIST_CHILDREN);
                    if (parentList)
                        parentList.style.maxHeight = `${parseInt(parentList.style.maxHeight) + scrollHeight}px`;
                }
            });
        } else if (isNewItem(orderItem)) {

            const newItem = this._buildNewItem(orderItem);

            orderItem.element = newItem;

            orderItem.element.setAttribute(ATTRIBUTE.PROCESSED, 'true');

            this._items.push(orderItem.element);
        } else if (orderItem.element) {

            const element = orderItem.element as HTMLAnchorElement;
            if (orderItem.href) {
                element.href = orderItem.href;
            }

            if (orderItem.target) {
                element.target = orderItem.target;
            }

        }

        // orderItem.element.style.order = `${orderIndex}`;

        if (orderItem.name) {
            this._subscribeName(
                orderItem.element,
                orderItem.name
            );
        }

        if (orderItem.icon) {
            this._subscribeIcon(
                orderItem.element,
                orderItem.icon
            );
        }

        if (orderItem.info) {
            this._subscribeInfo(
                orderItem.element,
                orderItem.info
            );
        }

        if (orderItem.notification) {
            this._subscribeNotification(
                orderItem.element,
                orderItem.notification
            );
        }

        if (typeof orderItem.hide !== 'undefined') {
            this._subscribeHide(
                orderItem.element,
                orderItem.hide
            );
        }

        this._subscribeTemplateColorChanges(
            orderItem,
            orderItem.element,
            ITEM_OPTIONS_VARIABLES_MAP
        );

        if (orderItem.new_item || isListItem(orderItem)) {

            // New items rollover
            orderItem.element.addEventListener(EVENT.MOUSEENTER, this._mouseEnterBinded);
            orderItem.element.addEventListener(EVENT.MOUSELEAVE, this._mouseLeaveBinded);

        }

        // When the item is clicked
        orderItem.element.addEventListener(EVENT.MOUSEDOWN, this._itemTouchedBinded);
        orderItem.element.addEventListener(EVENT.KEYDOWN, (event: KeyboardEvent): void => {
            if (event.key === KEY.ENTER) {
                this._itemTouchedBinded();
            }
        });
        return orderItem.element;
    }

    private async _itemTouched(): Promise<void> {
        this._sidebar.selector.$.query(ELEMENT.PAPER_LISTBOX).element
            .then((paperListBox: HTMLElement): void => {
                this._sidebarScroll = paperListBox.scrollTop;
            });
    }

    private _mouseEnter(event: MouseEvent): void {
        this._sidebar.element
            .then((sidebar: Sidebar): void => {
                if (sidebar.alwaysExpand) {
                    return;
                }
                if (sidebar._mouseLeaveTimeout) {
                    clearTimeout(sidebar._mouseLeaveTimeout);
                    sidebar._mouseLeaveTimeout = undefined;
                }
                sidebar._showTooltip(event.currentTarget as HTMLAnchorElement);
            });
    }

    private async _mouseLeave(): Promise<void> {
        this._sidebar.element
            .then((sidebar: Sidebar): void => {
                if (sidebar._mouseLeaveTimeout) {
                    clearTimeout(sidebar._mouseLeaveTimeout);
                }
                sidebar._mouseLeaveTimeout = window.setTimeout(() => {
                    sidebar._hideTooltip();
                }, 500);
            });
    }

    private async _checkProfileEditableButton(): Promise<void> {
        const panelResolver = await this._partialPanelResolver.element as PartialPanelResolver;
        const pathName = panelResolver.__route.path;
        // Disable the edit sidebar button in the profile panel
        if (pathName === PROFILE_GENERAL_PATH) {
            const editSidebarButton = await this._partialPanelResolver.selector.query(SELECTOR.EDIT_SIDEBAR_BUTTON).element;
            if (editSidebarButton) {
                if (this._isSidebarEditable === false) {
                    editSidebarButton.setAttribute(ATTRIBUTE.DISABLED, '');
                } else {
                    editSidebarButton.removeAttribute(ATTRIBUTE.DISABLED);
                }
            }
        }
    }

    private async _panelLoaded(): Promise<void> {

        // Select the right element in the sidebar
        const panelResolver = await this._partialPanelResolver.element as PartialPanelResolver;
        const pathName = panelResolver.__route.path;
        const paperListBox = await this._sidebar.selector.$.query(ELEMENT.PAPER_LISTBOX).element as HTMLElement;
        const activeLink = paperListBox.querySelector<HTMLAnchorElement>(
            `
               ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}[href="${pathName}"],
               ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}[href="${pathName}/dashboard"]
            `
        );

        const activeParentLink = activeLink
            ? null
            : this._items.reduce((link: HTMLAnchorElement | null, anchor: HTMLAnchorElement): HTMLAnchorElement | null => {
                const href = anchor.getAttribute(ATTRIBUTE.HREF);
                if (pathName.startsWith(href)) {
                    if (
                        !link ||
                        href.length > link.getAttribute(ATTRIBUTE.HREF).length
                    ) {
                        link = anchor;
                    }
                }
                return link;
            }, null);

        this._items.forEach((anchor: HTMLElement) => {
            const isActive = (
                activeLink &&
                (activeLink === anchor || activeLink.contains(anchor)) 
            ) ||
            (
                !activeLink &&
                activeParentLink === anchor
            );
            anchor.classList.toggle(CLASS.IRON_SELECTED, isActive);
            anchor.setAttribute(ATTRIBUTE.ARIA_SELECTED, `${isActive}`);
        });

        if (paperListBox.scrollTop !== this._sidebarScroll) {
            paperListBox.scrollTop = this._sidebarScroll;
        }

        this._checkProfileEditableButton();

    }

    private _process(): void {

        this._homeAssistant
            .element
            .then((ha: HomeAsssistantExtended) => {
                this._ha = ha;
                new HomeAssistantJavaScriptTemplates(this._ha)
                    .getRenderer()
                    .then((renderer) => {
                        this._renderer = renderer;
                        this._getConfig()
                            .then(() => {
                                this._renderer.variables = this._config.js_variables ?? {};
                                this._processSidebar();
                                this._subscribeTitle();
                                this._subscribeSideBarEdition();
                                this._rearrange();
                            });
                    });
            });
    }

}

if (!window.CustomSidebar) {
    logVersionToConsole();
    window.CustomSidebar = new CustomSidebar();
}