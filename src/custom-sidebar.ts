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
    JS_TEMPLATE_REG,
    JINJA_TEMPLATE_REG,
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
import { getFocusableElements } from 'utilities/modules/elements';

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
            () => this._panelLoaded(null)
        );

        selector.listen();

        this._styleManager = new HomeAssistantStylesManager({
            prefix: NAMESPACE,
            namespace: NAMESPACE,
            throwWarnings: false
        });

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
    private _sidebarItemHeight: number = 48; // Defaults to 48 but gets calculated at runtime using existing sidebar items
    private _renderer: HomeAssistantJavaScriptTemplatesRenderer;
    private _styleManager: HomeAssistantStylesManager;
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

    private async _getLinkElements(): Promise<[HTMLElement, NodeListOf<HTMLAnchorElement>, HTMLElement]> {
        const promisableResultOptions = {
            retries: MAX_ATTEMPTS,
            delay: RETRY_DELAY,
            shouldReject: false
        };
        const paperListBox = (await this._sidebar.selector.$.query(ELEMENT.PAPER_LISTBOX).element) as HTMLElement;
        const spacer = await getPromisableResult<HTMLAnchorElement>(
            () => paperListBox.querySelector<HTMLAnchorElement>(`:scope > ${SELECTOR.SPACER}`),
            (spacer: HTMLElement): boolean => !! spacer,
            promisableResultOptions
        );
        const items = await getPromisableResult<NodeListOf<HTMLAnchorElement>>(
            () => paperListBox.querySelectorAll<HTMLAnchorElement>(`:scope > ${SELECTOR.LINK_ITEM}`),
            (elements: NodeListOf<HTMLAnchorElement>): boolean => {
                return Array.from(elements).every((element: HTMLAnchorElement): boolean => {
                    const text = element.querySelector<HTMLElement>(SELECTOR.ITEM_TEXT).innerText.trim();
                    this._sidebarItemHeight = Math.max(Math.ceil(element.getBoundingClientRect().height), this._sidebarItemHeight);
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

    private _collapseList(list: HTMLElement): void {
        const topLevelElement = list.querySelector(SELECTOR.SIDEBAR_LIST_PARENT);
        const expanderIcon = list.querySelector(SELECTOR.SIDEBAR_LIST_COLLAPSE_ICON);
        const childrenList = <HTMLElement>list.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);

        expanderIcon.setAttribute('icon', 'mdi:chevron-down');
        topLevelElement.setAttribute(ATTRIBUTE.ARIA_EXPANDED, 'false');
        childrenList.classList.remove(CLASS.SIDEBAR_LIST_EXPANDED);
        childrenList.style.maxHeight = '0';
        childrenList.classList.add(CLASS.SIDEBAR_LIST_COLLAPSED);
    }

    private _expandList(list: HTMLElement): void {
        const topLevelElement = list.querySelector(SELECTOR.SIDEBAR_LIST_PARENT);
        const expanderIcon = list.querySelector(SELECTOR.SIDEBAR_LIST_COLLAPSE_ICON);
        const childrenList = <HTMLElement>list.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
        // if (parseInt(childrenList.style.maxHeight) > 0 && childrenList.style.visibility !== "hidden") {
        //     return; // Already expanded / expanding
        // }

        // childrenList.style.display = "block";

        childrenList.classList.remove(CLASS.SIDEBAR_LIST_COLLAPSED);
        childrenList.classList.add(CLASS.SIDEBAR_LIST_EXPANDED);
        topLevelElement.setAttribute(ATTRIBUTE.ARIA_EXPANDED, 'true');
        expanderIcon.setAttribute('icon', 'mdi:chevron-up');

        // If this is a nested list, we need to update the parent's max-height as well
        const parentListChildren = <HTMLElement>list.parentElement.closest(SELECTOR.SIDEBAR_LIST_CHILDREN);
        if (parentListChildren) {
            parentListChildren.style.maxHeight = `${this._computeVisibleChildren(parentListChildren) *  this._sidebarItemHeight}px`;
        }

        const visibleChildren = this._computeVisibleChildren(list);
        childrenList.style.maxHeight = `${visibleChildren * this._sidebarItemHeight}px`;

        const durationCss = getComputedStyle(childrenList).transitionDuration;
        const durationMs =  parseFloat(durationCss) * (/\ds$/.test(durationCss) ? 1000 : 1);
        setTimeout(() => childrenList.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), durationMs * .8);
    }
    private _buildListItem(orderItem: ConfigListItem, existingElements: HTMLAnchorElement[], matched: Set<HTMLAnchorElement>): HTMLElement {
        // Container for the list item expanded/collapse top-level element and its children
        const listItemContainer = document.createElement('div');
        listItemContainer.setAttribute(ATTRIBUTE.ROLE, 'group');
        listItemContainer.setAttribute(ATTRIBUTE.TABINDEX, '-1');
        listItemContainer.className = CLASS.SIDEBAR_LIST;
        listItemContainer.classList.add(CLASS.SIDEBAR_ITEM);

        // Create the top-level element (i.e the label that the other links are nested under)
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
        topLevelElement.setAttribute(ATTRIBUTE.PROCESSED, 'true');
        listItemContainer.appendChild(topLevelElement);

        // Build the children of the top-level element
        const listItemChildren = this._buildListItemChildren(topLevelElement, orderItem.children, existingElements, matched);
        listItemContainer.appendChild(listItemChildren);
        const childrenList = <HTMLElement>listItemContainer.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
        childrenList.classList.add(orderItem.collapsed ? CLASS.SIDEBAR_LIST_COLLAPSED : CLASS.SIDEBAR_LIST_EXPANDED);
        if (!orderItem.collapsed)
            setTimeout(() => {
                // Waits for DOM to settle before measuring (for example, existing sidebar items that are added as a child of this list in the config, have not been moved yet in the DOM)
                childrenList.style.maxHeight = `${this._computeVisibleChildren(listItemContainer) * this._sidebarItemHeight}px`;
            });

        const toggleListExpandedHandler = (): void => {
            const childrenList = <HTMLElement>listItemContainer.querySelector(SELECTOR.SIDEBAR_LIST_CHILDREN);
            const isOpening = childrenList.classList.contains(CLASS.SIDEBAR_LIST_COLLAPSED); // If the list is currently collapsed, we are opening it
            // Set timeout with 0ms to allow the browser to render the display block before calculating the scrollHeight TODO
            setTimeout(() => (isOpening) ? this._expandList(listItemContainer) : this._collapseList(listItemContainer));

        };
        topLevelElement.addEventListener(EVENT.CLICK, toggleListExpandedHandler);
        listItemContainer.addEventListener(EVENT.KEYDOWN, (event: KeyboardEvent) => {
            if (event.target === listItemContainer) {
                if ((event.key === 'Enter' || event.key === ' ')) {
                    toggleListExpandedHandler();
                    event.preventDefault();
                    event.stopPropagation();
                }
                //  else if (event.key === "Tab" && !event.shiftKey) {
                //     const focusChildren = getFocusableElements(childrenList);
                //     if (focusChildren.length > 0) {
                //         focusChildren[0].focus();
                //         event.preventDefault();
                //         event.stopPropagation();
                //     }
                // }
            }
            // } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            //     const focusChildren = getFocusableElements(listItemContainer);
            //     if (focusChildren.length > 0) {
            //         const currentIndex = focusChildren.indexOf(<HTMLElement>event.target);
            //         const nextIndex = currentIndex + (event.key === "ArrowDown" ? 1 : -1);
            //         if (nextIndex >= 0 && nextIndex < focusChildren.length) {
            //             focusChildren[nextIndex].focus();
            //         } else {
            //             listItemContainer.focus();
            //         }
            //         event.preventDefault();
            //         event.stopPropagation();
            //     }
            // }
        });

        return listItemContainer;
    }

    private _buildListItemChildren(topLevelElement: HTMLElement, children: ConfigOrder[], existingElements: HTMLAnchorElement[], matched: Set<HTMLAnchorElement>): HTMLDivElement {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = CLASS.SIDEBAR_LIST_CHILDREN;
        childrenContainer.setAttribute(ATTRIBUTE.ROLE, 'group');
        children.sort( (a: ConfigOrder, b: ConfigOrder): number => {
            if (!a || !b) {
                return 0;
            }
            const c = (a.order || children.indexOf(a)) - (b.order || children.indexOf(b));
            // If order is the same, prefer the one with an explicit order
            if (c === 0) {
                if (a.order === undefined) { return 1; }
                else if (b.order === undefined) { return -1; }
                else { return 0; }
            }
            return c;
        });
        for (const child of children) {
            if(child) {
                const configOrderWithItem = this._getConfigOrderWithItem(child, existingElements, matched); // isBottom = undefined because we are in a list so this is determined by the parent
                if (configOrderWithItem && configOrderWithItem.element) {
                    (<ConfigOrderWithItem>child).element = configOrderWithItem.element;
                    childrenContainer.appendChild(configOrderWithItem.element);
                    this._setupConfigItemListeners(configOrderWithItem);
                } else {
                    console.warn(`Sidebar item ${child.item} not found in the DOM. It should be declared with "new_item: true" in the config`);
                    continue;
                }
            }
            else
                console.warn(topLevelElement, 'Child of list item is undefined');
        }
        return childrenContainer;
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

    private _focusNextElement(sidebar: ShadowRoot, forward: boolean, wrap: boolean): boolean {
        const focusableElements = getFocusableElements(sidebar).filter(el => el.nodeName.toLowerCase() !== 'paper-listbox');
        let activeElement = document.activeElement;
        while (activeElement.shadowRoot && activeElement.shadowRoot.activeElement) {
            activeElement = activeElement.shadowRoot.activeElement;
        }
        const currentIndex = focusableElements.indexOf(activeElement as HTMLElement);

        if (currentIndex === -1 ) {
            return false;
        } else {
            if (wrap) {
                let nextIndex = (currentIndex + (forward ? 1 : -1)) % focusableElements.length;
                if (nextIndex < 0 )
                    nextIndex = focusableElements.length - 1;
                focusableElements[nextIndex].focus();
                return true;
            } else {
                if (forward && currentIndex === focusableElements.length - 1) {
                    return false;
                } else if (!forward && currentIndex === 0) {
                    return false;
                } else {
                    const nextIndex = currentIndex + (forward ? 1 : -1);
                    focusableElements[nextIndex].focus();
                    return true;
                }
            }
        }
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
            this._sidebar.selector.$.element
        ]).then(([mcDrawer, sidebar, sideBarShadowRoot]: [HTMLElement, HTMLElement, ShadowRoot]) => {

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

            sidebar.addEventListener(EVENT.KEYDOWN, (event: KeyboardEvent) => {
                if (
                    event.key === KEY.ARROW_DOWN ||
                    event.key === KEY.ARROW_UP ||
                    event.key === KEY.TAB
                ) {
                    if (this._focusNextElement(sidebar.shadowRoot, event.key === KEY.ARROW_DOWN || (event.key === KEY.TAB && !event.shiftKey), event.key !== KEY.TAB)) {
                        event.preventDefault();
                        event.stopPropagation();
                        event.stopImmediatePropagation();
                    }
                }
            }, true);

            // window.addEventListener(EVENT.KEYDOWN, (event: KeyboardEvent) => {
            //     if (
            //         event.key === KEY.TAB
            //     ) {
            //         const activePaperItem = this._getActivePaperIconElement();
            //         if (activePaperItem) {
            //             if (activePaperItem.nodeName === NODE_NAME.PAPER_ICON_ITEM) {
            //                 const parentElement = activePaperItem.parentElement as HTMLElement;
            //                 if (parentElement.getAttribute(ATTRIBUTE.HREF) !== PROFILE_PATH) {
            //                     event.preventDefault();
            //                     event.stopImmediatePropagation();
            //                     this._focusItemByTab(sideBarShadowRoot, parentElement, !event.shiftKey); TODO
            //                 }
            //             } else if (activePaperItem.getAttribute(ATTRIBUTE.HREF) !== PROFILE_PATH) {
            //                 event.preventDefault();
            //                 event.stopImmediatePropagation();
            //                 this._focusItemByTab(sideBarShadowRoot, activePaperItem as HTMLElement, !event.shiftKey); TODO
            //             }
            //         }
            //     }
            // }, true);

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
        this._getLinkElements()
            .then((elements) => {

                const { hide_all } = this._config;
                const [paperListBox, itemsNodeList, spacer] = elements;
                const items = Array.from<HTMLAnchorElement>(itemsNodeList);
                let crossedBottom = false;


                if (hide_all) {
                    items.forEach((element: HTMLAnchorElement): void => {
                        this._hideAnchor(element, true);
                    });
                }

                this.processConfig(paperListBox, Array.from(items)).forEach((element: HTMLElement): void => {
                    if (element.getAttribute(ATTRIBUTE.BOTTOM) === 'true' && !crossedBottom) {
                        paperListBox.appendChild(spacer);
                        crossedBottom = true;
                    }
                    paperListBox.appendChild(element);
                });

                if (!crossedBottom) {
                    paperListBox.appendChild(spacer);
                }

                this._panelLoaded(items);
            });
    }

    private _matchElementToConfigItem(existingElements: HTMLAnchorElement[], configItem: ConfigOrder, matched: Set<HTMLElement>): HTMLElement | undefined {
        const element = existingElements.find((element: HTMLAnchorElement): boolean => {
            const { item, match, exact } = configItem;
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

        if (element) {
            element.setAttribute(ATTRIBUTE.PROCESSED, 'true');
            element.classList.add(CLASS.SIDEBAR_ITEM);
            if (configItem.href) {
                element.href = configItem.href;
            }
            if (configItem.target) {
                element.target = configItem.target;
            }
        }

        return element;
    }


    private processConfig(paperListBox: HTMLElement, existingElements: HTMLAnchorElement[]): HTMLElement[] {
        const { order } = this._config;
        const matched: Set<HTMLAnchorElement> = new Set();
        const configItems : ConfigOrderWithItem[] = order
            .filter((item: ConfigOrderWithItem): boolean => !!item)
            .map((item: ConfigOrder): ConfigOrderWithItem => this._getConfigOrderWithItem(item, existingElements, matched))
            .filter((item: ConfigOrderWithItem): boolean => !!item);

        const unmatched = existingElements.filter((element: HTMLAnchorElement): boolean => !matched.has(element));

        let orderIndex = 0;
        const sidebarElements: HTMLElement[] = [];

        const spacerIndex = Array.prototype.indexOf.call(paperListBox.childNodes, paperListBox.querySelector(SELECTOR.SPACER));

        unmatched.forEach((element: HTMLAnchorElement): void => {
            const item =  element.getAttribute(ATTRIBUTE.PANEL) || element.getAttribute(ATTRIBUTE.HREF)
                          || element.querySelector<HTMLElement>(SELECTOR.ITEM_TEXT).innerText.trim().toLowerCase();
            configItems.push(<ConfigOrderWithItem>{item, element});
        });

        configItems.forEach((item) => {
            // If config explicitly sets bottom true, or if the item is after the spacer in the DOM by default (unless that element explicitly sets bottom to false)
            if (item.bottom === true || item.bottom === false) {
                item.element.setAttribute(ATTRIBUTE.BOTTOM, item.bottom.toString());
            } else if (item.element) {
                const itemIndex = Array.prototype.indexOf.call(paperListBox.childNodes, item.element);
                if (itemIndex > spacerIndex && item.bottom != false)
                    item.element.setAttribute(ATTRIBUTE.BOTTOM, 'true');
            } else if (!item) {
                console.warn(`${NAMESPACE}: error processing config item to a sidebar element:`, item);
                return;
            }

            this._setupConfigItemListeners(item);
            if (item.order) {
                item.element.setAttribute(ATTRIBUTE.ORDER, item.order.toString());
                if (item.order <= orderIndex)
                    orderIndex++;
            } else {
                item.element.setAttribute(ATTRIBUTE.ORDER, (orderIndex++).toString());
            }
            sidebarElements.push(item.element);
        });

        sidebarElements.sort(
            (
                sidebarItemA: HTMLElement,
                sidebarItemB: HTMLElement
            ): number => {
                if (sidebarItemA.getAttribute('bottom') && !sidebarItemB.getAttribute('bottom'))
                    return 1;
                else if (!sidebarItemA.getAttribute('bottom') && sidebarItemB.getAttribute('bottom'))
                    return -1;
                else
                    return parseInt(sidebarItemA.getAttribute(ATTRIBUTE.ORDER)) - parseInt(sidebarItemB.getAttribute(ATTRIBUTE.ORDER));
            }
        );


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

    private _getConfigOrderWithItem(orderItem: ConfigOrder, existingElements: HTMLAnchorElement[], matched: Set<HTMLAnchorElement>): ConfigOrderWithItem {
        if (isListItem(orderItem)) {
            const listElement = this._buildListItem(orderItem, existingElements, matched);
            listElement.setAttribute(ATTRIBUTE.PROCESSED, 'true');
            // orderItem.children = orderItem.children.map((child: ConfigOrder): ConfigOrderWithItem => this._getConfigOrderWithItem(child, existingElements, matched));
            return {
                ...orderItem,
                element: listElement
            };
        } else if (isNewItem(orderItem)) {
            const newItem = this._buildNewItem(orderItem);
            newItem.setAttribute(ATTRIBUTE.PROCESSED, 'true');
            return {
                ...orderItem,
                element: newItem
            };
        } else {
            const existingELement = this._matchElementToConfigItem(existingElements, orderItem, matched);
            if (existingELement) {
                existingELement.setAttribute(ATTRIBUTE.PROCESSED, 'true');
                existingELement.classList.add(CLASS.SIDEBAR_ITEM);
                return {
                    ...orderItem,
                    element: existingELement
                };
            } else {
                console.warn(`No existing sidebar element found for ${orderItem.item}. It should be declared with "new_item: true" or match an existing element in the sidebar`, orderItem);
                return null;
            }
        }
    }

    // Returns number of visible children, including nested list children. Needed for the list's max-height expand animation.
    private _computeVisibleChildren(element: HTMLElement): number {
        return Array.from(element.querySelectorAll<HTMLElement>(`${SELECTOR.SIDEBAR_LIST_PARENT}, ${SELECTOR.LINK_ITEM}`)).filter((child: HTMLElement) =>
            child.checkVisibility({checkVisibilityCSS: true, visibilityProperty: true})   // modern browser support
            || !!(child.offsetWidth || child.offsetHeight || child.getClientRects().length )  // jQuery visibility check
        ).length;
    }

    private _setupConfigItemListeners(orderItem: ConfigOrderWithItem): void {
        if (!orderItem.element) {
            console.error('Sidebar item has no element', orderItem);
            return;
        }
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
        if (!panelResolver) {
            return;
        }
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

    private async _panelLoaded(items?: HTMLElement[]): Promise<void> {

        // Select the right element in the sidebar
        const panelResolver = await this._partialPanelResolver.element as PartialPanelResolver;
        const pathName = panelResolver.__route.path;
        const paperListBox = await this._sidebar.selector.$.query(ELEMENT.PAPER_LISTBOX).element as HTMLElement;
        if (!items){
            items = Array.from(paperListBox.querySelectorAll<HTMLAnchorElement>(SELECTOR.LINK_ITEM));
        }

        const activeLink = paperListBox.querySelector<HTMLAnchorElement>(
            `
               ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}[href="${pathName}"],
               ${SELECTOR.SCOPE} > ${SELECTOR.ITEM}[href="${pathName}/dashboard"]
            `
        );

        const activeParentLink = activeLink
            ? null
            : items.reduce((link: HTMLAnchorElement | null, anchor: HTMLAnchorElement): HTMLAnchorElement | null => {
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

        if (paperListBox.scrollTop !== this._sidebarScroll) {
            paperListBox.scrollTop = this._sidebarScroll;
        }

        items.forEach((anchor: HTMLElement) => {
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
            if (isActive) {
                const list = <HTMLElement>anchor.closest(SELECTOR.SIDEBAR_LIST);
                if (list) {
                    this._expandList(list);
                    list.querySelector(SELECTOR.SIDEBAR_LIST_PARENT).classList.toggle(CLASS.IRON_SELECTED, isActive);
                    const nestedList = <HTMLElement>list.parentElement.closest(SELECTOR.SIDEBAR_LIST);
                    if (nestedList) {
                        this._expandList(nestedList);
                        nestedList.querySelector(SELECTOR.SIDEBAR_LIST_PARENT).classList.toggle(CLASS.IRON_SELECTED, isActive);
                    }
                }
                anchor.scrollIntoView({ behavior: 'instant', block: 'center' });
            }
        });

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