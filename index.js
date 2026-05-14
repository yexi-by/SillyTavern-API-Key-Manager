import { extension_settings } from '../../../extensions.js';
import { event_types, eventSource, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { chat_completion_sources, custom_prompt_post_processing_types, oai_settings } from '../../../openai.js';
import { deleteSecret, readSecretState, rotateSecret, secret_state, SECRET_KEYS, writeSecret } from '../../../secrets.js';
import { Popup } from '../../../popup.js';
import { uuidv4 } from '../../../utils.js';

const MODULE_NAME = 'apiKeyManager';
const EXTENSION_ID = 'api-key-manager';
const DISPLAY_NAME = 'API Key 管家';
const CUSTOM_SOURCE = chat_completion_sources.CUSTOM;
const NEW_PROVIDER_ID = '__new_provider__';
const MODEL_FETCH_TIMEOUT_MS = 30000;
const MODEL_TEST_TIMEOUT_MS = 30000;
const MANAGED_INCLUDE_BODY_KEYS = new Set([
    'model',
    'messages',
    'prompt',
    'stream',
]);
const LOCKED_NATIVE_SELECTOR = [
    '#main_api',
    '#chat_completion_source',
    '#custom_api_url_text',
    '#custom_model_id',
    '#custom_include_headers',
    '#custom_include_body',
    '#custom_exclude_body',
    '#custom_prompt_post_processing',
    '#bind_preset_to_connection',
    '#api_key_custom',
    '#connection_profiles',
].join(',');

const CONNECTION_MANAGER_BUTTON_SELECTOR = [
    '#view_connection_profile',
    '#create_connection_profile',
    '#update_connection_profile',
    '#edit_connection_profile',
    '#reload_connection_profile',
    '#delete_connection_profile',
].join(',');

const DEFAULT_SETTINGS = {
    version: 1,
    enabled: true,
    activeProviderId: null,
    providers: [],
    ui: {
        panelOpen: false,
        placement: 'bottom-right',
        position: null,
        settingsCollapsed: false,
    },
    lockNativeConnection: true,
};

const state = {
    editingProviderId: null,
    panelEditorOpen: false,
    pluginApplying: false,
    renderTimer: null,
    repairTimer: null,
    observer: null,
    modelRequests: new Set(),
    testingProviders: new Set(),
    drag: null,
    suppressNextFabClick: false,
};

/**
 * 初始化 API Key 管家扩展，建立界面、事件拦截与预设防护。
 */
export async function init() {
    ensureSettings();
    ensureShell();
    ensureSettingsView();
    bindUiEvents();
    bindDragEvents();
    bindNativeInterceptors();
    bindPresetGuards();
    observeNativeUi();

    await readSecretState();
    hideNativeManagers();
    renderAll();

    const activeProvider = getActiveProvider();
    if (ensureSettings().enabled && activeProvider) {
        await applyProvider(activeProvider, 'init');
    }
}

/**
 * 获取并补齐扩展设置，避免旧配置缺字段导致运行期分支发散。
 * @returns {typeof DEFAULT_SETTINGS}
 */
function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[MODULE_NAME];
    settings.version = 1;
    settings.enabled = settings.enabled !== false;
    settings.providers = Array.isArray(settings.providers)
        ? settings.providers.reduce((providers, provider) => {
            const normalizedProvider = normalizeProvider(provider);
            if (!normalizedProvider || !provider || typeof provider !== 'object') {
                return providers;
            }

            Object.assign(provider, normalizedProvider);
            providers.push(provider);
            return providers;
        }, [])
        : [];
    settings.ui = {
        ...DEFAULT_SETTINGS.ui,
        ...(settings.ui || {}),
    };
    settings.ui.position = normalizeSavedPosition(settings.ui.position);
    settings.ui.settingsCollapsed = Boolean(settings.ui.settingsCollapsed);
    settings.lockNativeConnection = settings.lockNativeConnection !== false;

    if (!settings.activeProviderId && settings.providers.length > 0) {
        settings.activeProviderId = settings.providers[0].id;
    }

    if (settings.activeProviderId && !settings.providers.some(provider => provider.id === settings.activeProviderId)) {
        settings.activeProviderId = settings.providers[0]?.id || null;
    }

    if (state.editingProviderId === null && settings.activeProviderId) {
        state.editingProviderId = settings.activeProviderId;
    }

    return settings;
}

/**
 * 规范化服务商结构，保证渲染与应用流程只面对一种数据形态。
 * @param {Record<string, unknown>} provider 原始服务商配置。
 * @returns {Record<string, unknown>|null} 规范化后的服务商配置。
 */
function normalizeProvider(provider) {
    if (!provider || typeof provider !== 'object') {
        return null;
    }

    const now = new Date().toISOString();
    const customModels = uniqueModels(Array.isArray(provider.customModels) ? provider.customModels : []);
    const models = uniqueModels([...(Array.isArray(provider.models) ? provider.models : []), ...customModels, provider.activeModel]);
    const activeModel = String(provider.activeModel || '').trim() || models[0] || '';

    return {
        id: String(provider.id || createId()),
        name: String(provider.name || 'OpenAI 兼容 LLM 服务').trim(),
        baseUrl: String(provider.baseUrl || '').trim(),
        models,
        customModels,
        activeModel,
        secretId: String(provider.secretId || '').trim(),
        secretLabel: String(provider.secretLabel || '').trim(),
        modelsLoadedAt: String(provider.modelsLoadedAt || '').trim(),
        modelFetchError: String(provider.modelFetchError || '').trim(),
        lastTestStatus: String(provider.lastTestStatus || '').trim(),
        lastTestMessage: String(provider.lastTestMessage || '').trim(),
        promptPostProcessing: normalizePromptPostProcessing(provider.promptPostProcessing),
        includeHeaders: String(provider.includeHeaders || '').trim(),
        includeBody: String(provider.includeBody || '').trim(),
        excludeBody: String(provider.excludeBody || '').trim(),
        createdAt: String(provider.createdAt || now),
        updatedAt: String(provider.updatedAt || now),
    };
}

/**
 * 创建扩展的悬浮球和弹出层外壳。
 */
function ensureShell() {
    if (document.getElementById('akm-root')) {
        return;
    }

    document.body.insertAdjacentHTML('beforeend', `
        <div id="akm-root" class="akm-root" data-placement="bottom-right">
            <button id="akm-fab" class="akm-fab" type="button" aria-haspopup="dialog" aria-expanded="false" title="${DISPLAY_NAME}">
                <span class="akm-fab-status" aria-hidden="true"></span>
                <span class="akm-fab-label">AK</span>
            </button>
            <section id="akm-panel" class="akm-panel" role="dialog" aria-label="${DISPLAY_NAME}"></section>
        </div>
    `);
}

/**
 * 在扩展程序设置页挂载控制台设置，避免污染 SillyTavern 原 API 连接页。
 */
function ensureSettingsView() {
    const existing = document.getElementById('akm-settings');
    if (existing && existing.closest('#extensions_settings2')) {
        return;
    }

    existing?.remove();

    const container = document.getElementById('extensions_settings2');
    if (!container) {
        return;
    }

    container.insertAdjacentHTML('afterbegin', '<section id="akm-settings" class="akm-settings"></section>');
}

/**
 * 在原 API 连接页挂载接管提示，说明该页功能已由插件屏蔽。
 */
function ensureNativeWarning() {
    const container = document.getElementById('rm_api_block');
    if (!container || document.getElementById('akm-api-warning')) {
        return;
    }

    container.insertAdjacentHTML('afterbegin', `
        <section id="akm-api-warning" class="akm-api-warning">
            <div>
                <strong>LLM 连接已由 ${DISPLAY_NAME} 接管</strong>
                <span>此页面的 API 连接、模型、密钥与连接档案操作已被屏蔽。请通过悬浮窗打开 LLM 管理控制台。</span>
            </div>
            <button class="akm-text-button" type="button" data-akm-action="open-console">
                <i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i>
                <span>打开控制台</span>
            </button>
        </section>
    `);
}

/**
 * 绑定扩展自身 UI 的委托事件。
 */
function bindUiEvents() {
    document.addEventListener('click', async event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const actionElement = target.closest('[data-akm-action]');
        if (!actionElement) {
            return;
        }

        const action = actionElement.getAttribute('data-akm-action');
        const providerId = actionElement.getAttribute('data-provider-id') || '';
        const modelId = actionElement.getAttribute('data-model-id') || '';
        const actionScope = actionElement.closest('#akm-panel') ? 'panel' : 'settings';

        switch (action) {
            case 'toggle-panel':
                if (state.suppressNextFabClick) {
                    state.suppressNextFabClick = false;
                    event.preventDefault();
                    return;
                }
                togglePanel();
                break;
            case 'open-console':
                setPanelOpen(true);
                break;
            case 'toggle-enabled':
                if (actionElement instanceof HTMLInputElement) {
                    return;
                }
                await setConsoleEnabled(!ensureSettings().enabled);
                break;
            case 'close-panel':
                state.panelEditorOpen = false;
                setPanelOpen(false);
                break;
            case 'new-provider':
                state.editingProviderId = NEW_PROVIDER_ID;
                state.panelEditorOpen = actionScope === 'panel';
                ensureSettings().ui.settingsCollapsed = false;
                if (actionScope === 'panel') {
                    setPanelOpen(true);
                }
                renderAll();
                focusProviderForm(actionScope);
                break;
            case 'edit-provider':
                state.editingProviderId = providerId || getActiveProvider()?.id || null;
                state.panelEditorOpen = actionScope === 'panel';
                ensureSettings().ui.settingsCollapsed = false;
                if (actionScope === 'panel') {
                    setPanelOpen(true);
                }
                renderAll();
                focusProviderForm(actionScope);
                break;
            case 'toggle-settings':
                toggleSettingsCollapsed();
                break;
            case 'select-model':
                await activateModel(modelId, providerId);
                break;
            case 'add-custom-model':
                await addCustomModel(providerId || getActiveProvider()?.id || '', actionElement);
                break;
            case 'refresh-models':
                await refreshProviderModels(providerId || getActiveProvider()?.id || '', {
                    apply: true,
                    notifySuccess: true,
                    reason: 'manual-refresh',
                });
                break;
            case 'test-provider':
                await handleTestAction(actionElement, providerId);
                break;
            case 'delete-provider':
                await deleteProvider(providerId || getActiveProvider()?.id || '');
                break;
            case 'activate-provider':
                await activateProvider(providerId);
                break;
            case 'focus-settings':
                focusProviderForm('settings');
                break;
            default:
                break;
        }
    });

    document.addEventListener('change', async event => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.matches('[data-akm-action="toggle-enabled"]')) {
            await setConsoleEnabled(target.checked);
            return;
        }

        if (!(target instanceof HTMLSelectElement)) {
            return;
        }

        if (target.id === 'akm-panel-provider') {
            await activateProvider(target.value);
        }
    });

    document.addEventListener('submit', async event => {
        const target = event.target;
        if (!(target instanceof HTMLFormElement) || !target.matches('[data-akm-provider-form]')) {
            return;
        }

        event.preventDefault();
        await saveProviderFromForm(target);
    });

    document.addEventListener('keydown', async event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('[data-akm-custom-model-input]') || event.key !== 'Enter') {
            return;
        }

        event.preventDefault();
        const providerId = target.getAttribute('data-provider-id') || getActiveProvider()?.id || '';
        await addCustomModel(providerId, target);
    });

    document.addEventListener('focusin', unlockAutofillGuard, true);
    document.addEventListener('pointerdown', unlockAutofillGuard, true);
}

/**
 * 新增服务商表单短暂使用 readonly 避免浏览器把旧 Key 自动回填，用户聚焦时立即解锁。
 * @param {Event} event 输入聚焦或指针事件。
 */
function unlockAutofillGuard(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-akm-autofill-lock]')) {
        return;
    }

    target.removeAttribute('readonly');
    target.removeAttribute('data-akm-autofill-lock');
}

/**
 * 绑定悬浮球与面板标题的拖动行为，允许用户把常驻入口放到不遮挡聊天的位置。
 */
function bindDragEvents() {
    if (document.body.dataset.akmDragBound === 'true') {
        return;
    }

    document.body.dataset.akmDragBound = 'true';

    document.addEventListener('pointerdown', event => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || event.button !== 0) {
            return;
        }

        const handle = target.closest('#akm-fab, #akm-panel .akm-panel-head');
        if (!(handle instanceof HTMLElement)) {
            return;
        }

        if (target.closest('button:not(#akm-fab), input, select, textarea, a')) {
            return;
        }

        startFloatingDrag(event, handle);
    });

    document.addEventListener('pointermove', moveFloatingDrag);
    document.addEventListener('pointerup', finishFloatingDrag);
    document.addEventListener('pointercancel', finishFloatingDrag);

    window.addEventListener('resize', () => {
        const settings = ensureSettings();
        const root = document.getElementById('akm-root');
        if (!root || !settings.ui.position) {
            return;
        }

        settings.ui.position = clampRootPosition(settings.ui.position.left, settings.ui.position.top, root);
        applyRootPosition(root, settings);
        saveSettingsDebounced();
    });
}

/**
 * 开始拖动悬浮入口。
 * @param {PointerEvent} event 指针事件。
 * @param {HTMLElement} handle 拖动手柄。
 */
function startFloatingDrag(event, handle) {
    const root = document.getElementById('akm-root');
    if (!root) {
        return;
    }

    const rect = root.getBoundingClientRect();
    state.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        currentLeft: rect.left,
        currentTop: rect.top,
        moved: false,
    };

    root.classList.add('akm-dragging');
    try {
        handle.setPointerCapture?.(event.pointerId);
    } catch {
        // 合成事件或少数浏览器实现可能没有活动指针，拖动仍可由 document 级监听完成。
    }
}

/**
 * 拖动过程中实时更新悬浮入口位置。
 * @param {PointerEvent} event 指针事件。
 */
function moveFloatingDrag(event) {
    if (!state.drag || state.drag.pointerId !== event.pointerId) {
        return;
    }

    const root = document.getElementById('akm-root');
    if (!root) {
        return;
    }

    const deltaX = event.clientX - state.drag.startX;
    const deltaY = event.clientY - state.drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
        state.drag.moved = true;
    }

    const nextPosition = clampRootPosition(state.drag.startLeft + deltaX, state.drag.startTop + deltaY, root);
    state.drag.currentLeft = nextPosition.left;
    state.drag.currentTop = nextPosition.top;
    root.style.left = `${nextPosition.left}px`;
    root.style.top = `${nextPosition.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    event.preventDefault();
}

/**
 * 结束拖动并持久化位置。
 * @param {PointerEvent} event 指针事件。
 */
function finishFloatingDrag(event) {
    if (!state.drag || state.drag.pointerId !== event.pointerId) {
        return;
    }

    const root = document.getElementById('akm-root');
    const dragged = Boolean(state.drag.moved);
    const left = state.drag.currentLeft;
    const top = state.drag.currentTop;
    state.drag = null;
    root?.classList.remove('akm-dragging');

    if (!dragged) {
        return;
    }

    const settings = ensureSettings();
    settings.ui.position = { left, top };
    settings.ui.placement = 'custom';
    state.suppressNextFabClick = true;
    window.setTimeout(() => {
        state.suppressNextFabClick = false;
    }, 180);
    saveSettingsDebounced();
}

/**
 * 绑定原生管理功能的捕获期拦截。
 */
function bindNativeInterceptors() {
    document.addEventListener('click', handleNativeClick, true);
    document.addEventListener('input', handleNativeMutationAttempt, true);
    document.addEventListener('change', handleNativeMutationAttempt, true);
}

/**
 * 绑定预设切换保护，阻止预设接管连接字段。
 */
function bindPresetGuards() {
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, payload => {
        const settings = ensureSettings();
        if (!settings.enabled || !settings.lockNativeConnection || !getActiveProvider()) {
            return;
        }

        if (payload?.settings) {
            payload.settings.bind_preset_to_connection = false;
        }
        oai_settings.bind_preset_to_connection = false;
        $('#bind_preset_to_connection').prop('checked', false);
    });

    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => scheduleRepair('preset-after'));
    eventSource.on(event_types.PRESET_CHANGED, () => scheduleRepair('preset-changed'));
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => scheduleRepair('source-changed'));
    eventSource.on(event_types.SECRET_ROTATED, key => {
        if (key === SECRET_KEYS.CUSTOM) {
            scheduleRepair('secret-rotated');
        }
    });
}

/**
 * 观察原界面动态插入，确保内置 Connection Profiles 被持续隐藏。
 */
function observeNativeUi() {
    if (state.observer) {
        return;
    }

    state.observer = new MutationObserver(() => {
        ensureSettingsView();
        ensureNativeWarning();
        hideNativeManagers();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * 捕获原 API Key 管理器和 Connection Profiles 的点击。
 * @param {MouseEvent} event 点击事件。
 */
function handleNativeClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const settings = ensureSettings();
    if (!settings.enabled) {
        return;
    }

    if (target.closest('#rm_api_block') && !target.closest('#akm-api-warning')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPanelOpen(true);
        return;
    }

    const keyButton = target.closest('#openai_api .manage-api-keys');
    const connectionButton = target.closest(CONNECTION_MANAGER_BUTTON_SELECTOR);

    if (!keyButton && !connectionButton) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    setPanelOpen(true);
}

/**
 * 捕获原连接控件的手动改动，并恢复插件选择。
 * @param {Event} event 输入或变更事件。
 */
function handleNativeMutationAttempt(event) {
    if (state.pluginApplying) {
        return;
    }

    const settings = ensureSettings();
    if (!settings.enabled || !settings.lockNativeConnection) {
        return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('#akm-root, #akm-settings')) {
        return;
    }

    if (target.closest('#rm_api_block') && !target.closest('#akm-api-warning')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        scheduleRepair('native-api-page');
        return;
    }

    if (!getActiveProvider()) {
        return;
    }

    if (!target.closest(LOCKED_NATIVE_SELECTOR)) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    scheduleRepair('native-control');
}

/**
 * 隐藏原 API Key 管理按钮和内置 Connection Profiles。
 */
function hideNativeManagers() {
    ensureNativeWarning();
    const settings = ensureSettings();
    const apiBlock = document.getElementById('rm_api_block');
    const warning = document.getElementById('akm-api-warning');

    if (!settings.enabled) {
        apiBlock?.classList.remove('akm-api-locked');
        warning?.classList.add('akm-native-hidden');
        restoreNativeManagers();
        return;
    }

    apiBlock?.classList.add('akm-api-locked');
    warning?.classList.remove('akm-native-hidden');

    document.querySelectorAll('#openai_api .manage-api-keys').forEach(element => {
        element.classList.add('akm-native-hidden');
        element.setAttribute('aria-hidden', 'true');
    });

    const customKeyInput = document.getElementById('api_key_custom');
    if (customKeyInput instanceof HTMLInputElement) {
        customKeyInput.value = '';
        customKeyInput.disabled = true;
        customKeyInput.closest('.flex-container')?.classList.add('akm-native-hidden');
        customKeyInput.closest('form')?.querySelector('[data-for="api_key_custom"]')?.classList.add('akm-native-hidden');
    }

    document.querySelectorAll('#chat_completion_source, #custom_api_url_text, #custom_model_id, #bind_preset_to_connection').forEach(element => {
        element.classList.add('akm-native-locked');
        element.setAttribute('aria-disabled', 'true');
    });

    const profileSelect = document.getElementById('connection_profiles');
    const profileBlock = profileSelect?.closest('.wide100p');
    if (profileBlock) {
        profileBlock.classList.add('akm-native-hidden');
        profileBlock.setAttribute('aria-hidden', 'true');
    }
}

/**
 * 停用控制台时恢复原生 API 页控件。
 */
function restoreNativeManagers() {
    document.querySelectorAll('.akm-native-hidden').forEach(element => {
        if (element.id === 'akm-api-warning') {
            return;
        }

        element.classList.remove('akm-native-hidden');
        element.removeAttribute('aria-hidden');
    });

    document.querySelectorAll('.akm-native-locked').forEach(element => {
        element.classList.remove('akm-native-locked');
        element.removeAttribute('aria-disabled');
    });

    const customKeyInput = document.getElementById('api_key_custom');
    if (customKeyInput instanceof HTMLInputElement) {
        customKeyInput.disabled = false;
    }
}

/**
 * 渲染所有扩展界面。
 */
function renderAll() {
    const settings = ensureSettings();
    ensureSettingsView();
    ensureNativeWarning();
    const root = document.getElementById('akm-root');
    if (root) {
        root.dataset.placement = settings.ui.placement;
        root.classList.toggle('akm-open', Boolean(settings.ui.panelOpen));
        root.classList.toggle('akm-disabled', !settings.enabled);
        applyRootPosition(root, settings);
    }

    hideNativeManagers();
    renderFloatingButton(settings);
    renderPanel(settings);
    renderSettings(settings);
}

/**
 * 下一帧合并渲染，避免连续事件导致界面抖动。
 */
function renderSoon() {
    if (state.renderTimer) {
        return;
    }

    state.renderTimer = requestAnimationFrame(() => {
        state.renderTimer = null;
        renderAll();
    });
}

/**
 * 渲染悬浮球。
 * @param {typeof DEFAULT_SETTINGS} settings 扩展设置。
 */
function renderFloatingButton(settings) {
    const button = document.getElementById('akm-fab');
    if (!button) {
        return;
    }

    const activeProvider = getActiveProvider();
    const label = settings.enabled ? (activeProvider ? getShortName(activeProvider.name) : 'L') : 'O';
    const statusClass = !settings.enabled ? 'is-disabled' : activeProvider ? 'is-ready' : 'is-empty';
    button.setAttribute('data-akm-action', 'toggle-panel');
    button.setAttribute('aria-expanded', String(Boolean(settings.ui.panelOpen)));
    button.innerHTML = `
        <span class="akm-fab-status ${statusClass}" aria-hidden="true"></span>
        <span class="akm-fab-label">${escapeHtml(label)}</span>
    `;
}

/**
 * 渲染悬浮面板。
 * @param {typeof DEFAULT_SETTINGS} settings 扩展设置。
 */
function renderPanel(settings) {
    const panel = document.getElementById('akm-panel');
    if (!panel) {
        return;
    }

    if (!settings.enabled) {
        panel.innerHTML = `
            <div class="akm-panel-head">
                <div>
                    <span class="akm-kicker">SillyTavern LLM Console</span>
                    <strong>LLM 管理控制台已停用</strong>
                </div>
                <button class="akm-icon-button" type="button" data-akm-action="close-panel" title="关闭">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
            <div class="akm-empty">
                <strong>原 API 连接页已恢复可用</strong>
                <span>启用后，本插件会接管 OpenAI-compatible LLM 服务、模型切换、密钥持久化和连接参数。</span>
                <label class="akm-toggle-row">
                    <input type="checkbox" data-akm-action="toggle-enabled">
                    <span>启用 LLM 管理控制台</span>
                </label>
            </div>
        `;
        return;
    }

    const activeProvider = getActiveProvider();
    const providerOptions = settings.providers.map(provider => (
        `<option value="${escapeAttribute(provider.id)}" ${provider.id === settings.activeProviderId ? 'selected' : ''}>${escapeHtml(provider.name)}</option>`
    )).join('');

    if (state.panelEditorOpen) {
        const editingProvider = getEditingProvider();
        panel.innerHTML = `
            <div class="akm-panel-head">
                <div>
                    <span class="akm-kicker">SillyTavern LLM Console</span>
                    <strong>${editingProvider ? '编辑 LLM 服务' : '新增 LLM 服务'}</strong>
                </div>
                <button class="akm-icon-button" type="button" data-akm-action="close-panel" title="关闭">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
            ${renderProviderForm(editingProvider, 'panel')}
        `;
        return;
    }

    if (!activeProvider) {
        panel.innerHTML = `
            <div class="akm-panel-head">
                <div>
                    <span class="akm-kicker">SillyTavern LLM Console</span>
                    <strong>LLM 管理控制台</strong>
                </div>
                <button class="akm-icon-button" type="button" data-akm-action="close-panel" title="关闭">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
            <div class="akm-empty">
                <strong>尚未添加 LLM 服务</strong>
                <button class="akm-text-button" type="button" data-akm-action="new-provider">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    <span>新增 LLM 服务</span>
                </button>
            </div>
        `;
        return;
    }

    const lastStatus = renderProviderStatus(activeProvider);

    panel.innerHTML = `
        <div class="akm-panel-head">
            <div>
                <span class="akm-kicker">SillyTavern LLM Console</span>
                <strong>${escapeHtml(activeProvider.name)}</strong>
            </div>
            <button class="akm-icon-button" type="button" data-akm-action="close-panel" title="关闭">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        </div>
        <div class="akm-panel-fields">
            <label class="akm-field">
                <span>LLM 服务</span>
                <select id="akm-panel-provider" class="text_pole">${providerOptions}</select>
            </label>
            ${renderModelPicker(activeProvider, 'panel')}
        </div>
        <div class="akm-panel-meta">
            <span>${escapeHtml(activeProvider.baseUrl)}</span>
            ${lastStatus}
        </div>
        <div class="akm-panel-actions">
            <button class="menu_button" type="button" data-akm-action="test-provider" data-provider-id="${escapeAttribute(activeProvider.id)}" title="测试当前模型">
                <i class="fa-solid fa-vial-circle-check" aria-hidden="true"></i>
            </button>
            <button class="menu_button" type="button" data-akm-action="refresh-models" data-provider-id="${escapeAttribute(activeProvider.id)}" title="获取模型">
                <i class="fa-solid fa-rotate" aria-hidden="true"></i>
            </button>
            <button class="menu_button" type="button" data-akm-action="new-provider" title="新增 LLM 服务">
                <i class="fa-solid fa-plus" aria-hidden="true"></i>
            </button>
            <button class="menu_button" type="button" data-akm-action="edit-provider" data-provider-id="${escapeAttribute(activeProvider.id)}" title="编辑 LLM 服务">
                <i class="fa-solid fa-pen" aria-hidden="true"></i>
            </button>
            <button class="menu_button" type="button" data-akm-action="delete-provider" data-provider-id="${escapeAttribute(activeProvider.id)}" title="删除 LLM 服务">
                <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
            </button>
            <button class="menu_button" type="button" data-akm-action="focus-settings" title="打开配置">
                <i class="fa-solid fa-sliders" aria-hidden="true"></i>
            </button>
        </div>
    `;
}

/**
 * 渲染完整设置区。
 * @param {typeof DEFAULT_SETTINGS} settings 扩展设置。
 */
function renderSettings(settings) {
    const container = document.getElementById('akm-settings');
    if (!container) {
        return;
    }

    const collapsed = Boolean(settings.ui.settingsCollapsed);
    const editingProvider = getEditingProvider();
    const providerRows = settings.providers.map(provider => renderProviderRow(provider, settings.activeProviderId)).join('');
    const form = renderProviderForm(editingProvider);

    container.innerHTML = `
        <div class="akm-settings-head">
            <div>
                <h3>SillyTavern LLM 管理控制台</h3>
                <span>当前仅接管 OpenAI-compatible · ${settings.providers.length} 个 LLM 服务</span>
            </div>
            <div class="akm-settings-actions">
                <label class="akm-switch" title="${settings.enabled ? '停用控制台接管' : '启用控制台接管'}">
                    <input type="checkbox" data-akm-action="toggle-enabled" ${settings.enabled ? 'checked' : ''}>
                    <span></span>
                </label>
                <button class="akm-icon-button" type="button" data-akm-action="toggle-settings" title="${collapsed ? '展开配置' : '折叠配置'}" aria-expanded="${String(!collapsed)}">
                    <i class="fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}" aria-hidden="true"></i>
                </button>
                <button class="akm-text-button" type="button" data-akm-action="new-provider">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    <span>新增</span>
                </button>
            </div>
        </div>
        ${collapsed ? '' : `
            <div class="akm-console-note ${settings.enabled ? 'is-enabled' : 'is-disabled'}">
                <strong>${settings.enabled ? '控制台已接管原 API 连接页' : '控制台已停用'}</strong>
                <span>${settings.enabled ? 'URL 与 API Key 会持久化保存；模型、后处理与附加参数从悬浮控制台统一切换。' : '停用后原 API 连接页恢复，插件不会拦截原连接操作。'}</span>
            </div>
            <div class="akm-settings-grid">
                <div class="akm-provider-list" aria-label="LLM 服务列表">
                    ${providerRows || '<div class="akm-list-empty">暂无 LLM 服务</div>'}
                </div>
                ${form}
            </div>
        `}
    `;
}

/**
 * 渲染服务商列表行。
 * @param {Record<string, string|string[]>} provider 服务商配置。
 * @param {string|null} activeProviderId 当前服务商 ID。
 * @returns {string} HTML 片段。
 */
function renderProviderRow(provider, activeProviderId) {
    const active = provider.id === activeProviderId;
    const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
    const status = provider.lastTestStatus === 'success'
        ? '已测试'
        : provider.modelFetchError
            ? '模型获取失败'
            : `${modelCount} 个模型`;

    return `
        <div class="akm-provider-row ${active ? 'is-active' : ''}">
            <button type="button" data-akm-action="activate-provider" data-provider-id="${escapeAttribute(provider.id)}">
                <strong>${escapeHtml(provider.name)}</strong>
                <span>${escapeHtml(provider.activeModel || '未选择模型')} · ${escapeHtml(status)}</span>
            </button>
            <button class="akm-icon-button" type="button" data-akm-action="edit-provider" data-provider-id="${escapeAttribute(provider.id)}" title="编辑">
                <i class="fa-solid fa-pen" aria-hidden="true"></i>
            </button>
        </div>
    `;
}

/**
 * 渲染服务商编辑表单。
 * @param {Record<string, string|string[]>|null} provider 正在编辑的服务商。
 * @returns {string} HTML 片段。
 */
function renderProviderForm(provider, scope = 'settings') {
    const editing = Boolean(provider);
    const title = editing ? '编辑 LLM 服务' : '新增 LLM 服务';
    const submitText = editing ? '保存并获取模型' : '添加并获取模型';
    const suffix = scope === 'panel' ? 'panel' : 'settings';
    const newFormGuard = editing ? '' : 'readonly data-akm-autofill-lock="true"';
    const promptOptions = renderPromptPostProcessingOptions(provider?.promptPostProcessing || custom_prompt_post_processing_types.NONE);
    const modelArea = editing
        ? renderModelPicker(provider, suffix)
        : `
            <div class="akm-model-empty">
                保存 LLM 服务后会自动请求模型列表；模型名无需手动填写。
            </div>
        `;

    return `
        <form id="akm-provider-form-${suffix}" class="akm-provider-form" data-akm-provider-form="true" data-akm-form-scope="${escapeAttribute(suffix)}" data-editing-id="${escapeAttribute(provider?.id || '')}">
            <div class="akm-form-title">
                <h4>${title}</h4>
                ${editing ? `<span>${escapeHtml(provider.secretLabel || '已保存密钥')}</span>` : '<span>API Key 不会写入插件配置</span>'}
            </div>
            <label class="akm-field">
                <span>服务名称</span>
                <input id="akm-provider-name-${suffix}" class="text_pole" name="name" value="${escapeAttribute(provider?.name || '')}" autocomplete="off" required>
            </label>
            <label class="akm-field">
                <span>Base URL</span>
                <input id="akm-provider-base-url-${suffix}" class="text_pole" name="baseUrl" value="${escapeAttribute(provider?.baseUrl || '')}" placeholder="https://example.com/v1" autocomplete="${editing ? 'off' : 'new-password'}" ${newFormGuard} required>
            </label>
            ${modelArea}
            <details class="akm-advanced">
                <summary>
                    <span>原版兼容参数</span>
                    <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </summary>
                <label class="akm-field">
                    <span>提示词后处理</span>
                    <select class="text_pole" name="promptPostProcessing">
                        ${promptOptions}
                    </select>
                </label>
                <label class="akm-field">
                    <span>附加请求头</span>
                    <textarea class="text_pole" name="includeHeaders" rows="3" spellcheck="false" placeholder="X-Header: value">${escapeHtml(provider?.includeHeaders || '')}</textarea>
                </label>
                <label class="akm-field">
                    <span>附加请求体</span>
                    <textarea class="text_pole" name="includeBody" rows="3" spellcheck="false" placeholder="temperature: 0.7">${escapeHtml(provider?.includeBody || '')}</textarea>
                </label>
                <label class="akm-field">
                    <span>排除请求体字段</span>
                    <textarea class="text_pole" name="excludeBody" rows="2" spellcheck="false" placeholder="字段名，每行一个">${escapeHtml(provider?.excludeBody || '')}</textarea>
                </label>
            </details>
            <label class="akm-field">
                <span>API Key</span>
                <input id="akm-provider-api-key-${suffix}" class="text_pole" name="apiKey" value="" type="password" autocomplete="new-password" placeholder="${editing ? '留空则沿用已保存密钥' : '仅用于写入 SillyTavern secrets'}" ${newFormGuard} ${editing ? '' : 'required'}>
            </label>
            <div class="akm-form-actions">
                <button class="akm-text-button" type="submit">
                    <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                    <span>${submitText}</span>
                </button>
                <button class="akm-text-button" type="button" data-akm-action="test-provider" data-provider-id="${escapeAttribute(provider?.id || '')}">
                    <i class="fa-solid fa-vial-circle-check" aria-hidden="true"></i>
                    <span>测试当前模型</span>
                </button>
                ${editing ? `
                    <button class="akm-text-button" type="button" data-akm-action="refresh-models" data-provider-id="${escapeAttribute(provider.id)}">
                        <i class="fa-solid fa-rotate" aria-hidden="true"></i>
                        <span>获取模型</span>
                    </button>
                ` : ''}
                ${editing ? `
                    <button class="akm-text-button akm-danger-button" type="button" data-akm-action="delete-provider" data-provider-id="${escapeAttribute(provider.id)}">
                        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        <span>删除</span>
                    </button>
                ` : ''}
            </div>
        </form>
    `;
}

/**
 * 渲染模型选择框。模型来自服务商接口，不再让用户维护手写列表。
 * @param {Record<string, string|string[]>} provider 服务商配置。
 * @param {string} scope 渲染位置。
 * @returns {string} HTML 片段。
 */
function renderModelPicker(provider, scope) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const activeModel = String(provider?.activeModel || '').trim();
    const providerId = String(provider?.id || '');
    const loading = state.modelRequests.has(providerId) || state.testingProviders.has(providerId);
    const title = scope === 'panel' ? '模型' : '当前模型';
    const list = models.map(model => {
        const selected = model === activeModel;
        const custom = Array.isArray(provider.customModels) && provider.customModels.includes(model);
        return `
            <button class="akm-model-option ${selected ? 'is-selected' : ''}" type="button" role="option" aria-selected="${String(selected)}" data-akm-action="select-model" data-provider-id="${escapeAttribute(providerId)}" data-model-id="${escapeAttribute(model)}" title="${escapeAttribute(model)}">
                <span>${escapeHtml(model)}</span>
                <span class="akm-model-badges">
                    ${custom ? '<small>自定义</small>' : ''}
                    ${selected ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}
                </span>
            </button>
        `;
    }).join('');

    const empty = provider?.modelFetchError
        ? escapeHtml(provider.modelFetchError)
        : '尚未获取模型。点击“获取模型”，或先添加自定义模型名。';

    return `
        <div class="akm-field akm-model-field">
            <span>${title}</span>
            <div class="akm-current-model ${activeModel ? '' : 'is-empty'}">
                ${loading ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>' : '<i class="fa-solid fa-cube" aria-hidden="true"></i>'}
                <strong>${escapeHtml(activeModel || '未选择模型')}</strong>
            </div>
            ${models.length > 0 ? `
                <div class="akm-model-box" role="listbox" aria-label="模型列表">
                    ${list}
                </div>
            ` : `
                <div class="akm-model-empty">${empty}</div>
            `}
            <div class="akm-custom-model-row">
                <input class="text_pole" type="text" data-akm-custom-model-input data-provider-id="${escapeAttribute(providerId)}" autocomplete="off" placeholder="输入自定义模型名">
                <button class="akm-text-button" type="button" data-akm-action="add-custom-model" data-provider-id="${escapeAttribute(providerId)}">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    <span>添加</span>
                </button>
            </div>
        </div>
    `;
}

/**
 * 渲染服务商最近一次连接状态。
 * @param {Record<string, string|string[]>} provider 服务商配置。
 * @returns {string} HTML 片段。
 */
function renderProviderStatus(provider) {
    if (!provider?.lastTestMessage && !provider?.modelFetchError) {
        return '';
    }

    const success = provider.lastTestStatus === 'success';
    const message = provider.lastTestMessage || provider.modelFetchError;
    return `<span class="akm-provider-status ${success ? 'is-success' : 'is-error'}">${escapeHtml(message)}</span>`;
}

/**
 * 渲染 OpenAI-compatible 的提示词后处理选项。
 * @param {string} current 当前选项。
 * @returns {string} HTML 片段。
 */
function renderPromptPostProcessingOptions(current) {
    const options = [
        [custom_prompt_post_processing_types.NONE, '不处理'],
        [custom_prompt_post_processing_types.MERGE, '合并系统提示词'],
        [custom_prompt_post_processing_types.MERGE_TOOLS, '合并系统提示词与工具'],
        [custom_prompt_post_processing_types.SEMI, '半严格'],
        [custom_prompt_post_processing_types.SEMI_TOOLS, '半严格 + 工具'],
        [custom_prompt_post_processing_types.STRICT, '严格'],
        [custom_prompt_post_processing_types.STRICT_TOOLS, '严格 + 工具'],
        [custom_prompt_post_processing_types.SINGLE, '单条系统提示词'],
    ];

    return options.map(([value, label]) => (
        `<option value="${escapeAttribute(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`
    )).join('');
}

/**
 * 保存表单中的服务商配置。
 * @param {HTMLFormElement} form 配置表单。
 * @param {{afterSave?: 'test'}} options 保存后的附加动作。
 */
async function saveProviderFromForm(form, options = {}) {
    const settings = ensureSettings();
    const formData = new FormData(form);
    const editingId = String(form.dataset.editingId || '');
    const formScope = String(form.dataset.akmFormScope || 'settings');
    const existing = getProviderById(editingId);
    const now = new Date().toISOString();
    const name = String(formData.get('name') || '').trim();
    const baseUrl = String(formData.get('baseUrl') || '').trim();
    const apiKey = String(formData.get('apiKey') || '').trim();
    const models = Array.isArray(existing?.models) ? [...existing.models] : [];
    const customModels = Array.isArray(existing?.customModels) ? [...existing.customModels] : [];
    const activeModel = String(existing?.activeModel || '').trim();
    const promptPostProcessing = normalizePromptPostProcessing(formData.get('promptPostProcessing'));
    const includeHeaders = String(formData.get('includeHeaders') || '').trim();
    const includeBody = String(formData.get('includeBody') || '').trim();
    const excludeBody = String(formData.get('excludeBody') || '').trim();

    if (!name || !baseUrl) {
        notify('请填写 LLM 服务名称和 Base URL。', 'warning');
        return;
    }

    if (!apiKey && !existing?.secretId) {
        notify('请填写 API Key。', 'warning');
        return;
    }

    const includeBodyValidation = validateManagedIncludeBody(includeBody);
    if (!includeBodyValidation.ok) {
        notify(includeBodyValidation.message, 'warning');
        return;
    }

    let secretId = existing?.secretId || '';
    let secretLabel = existing?.secretLabel || `API Key 管家 / ${name}`;

    if (apiKey) {
        secretLabel = `API Key 管家 / ${name}`;
        const newSecretId = await writeSecret(SECRET_KEYS.CUSTOM, apiKey, secretLabel);
        if (!newSecretId) {
            notify('API Key 写入失败。', 'error');
            return;
        }

        if (existing?.secretId && existing.secretId !== newSecretId) {
            await deleteSecret(SECRET_KEYS.CUSTOM, existing.secretId);
        }
        secretId = newSecretId;
    }

    const provider = {
        id: existing?.id || createId(),
        name,
        baseUrl,
        models: uniqueModels([...models, ...customModels]),
        customModels: uniqueModels(customModels),
        activeModel,
        secretId,
        secretLabel,
        modelsLoadedAt: existing?.modelsLoadedAt || '',
        modelFetchError: existing?.modelFetchError || '',
        lastTestStatus: existing?.lastTestStatus || '',
        lastTestMessage: existing?.lastTestMessage || '',
        promptPostProcessing,
        includeHeaders,
        includeBody,
        excludeBody,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };

    const index = settings.providers.findIndex(item => item.id === provider.id);
    if (index >= 0) {
        settings.providers[index] = provider;
    } else {
        settings.providers.push(provider);
    }

    settings.activeProviderId = provider.id;
    state.editingProviderId = provider.id;
    state.panelEditorOpen = false;
    saveSettingsDebounced();

    if (options.afterSave === 'test') {
        if (!provider.activeModel) {
            await refreshProviderModels(provider.id, {
                apply: true,
                notifySuccess: false,
                reason: 'save-before-test',
            });
        }
        await testCurrentModel(provider.id);
    } else {
        await refreshProviderModels(provider.id, {
            apply: false,
            notifySuccess: false,
            reason: 'save-provider',
        });
        if (ensureSettings().enabled) {
            await applyProvider(getProviderById(provider.id), 'save-provider');
        }
        notify('LLM 服务已保存，已尝试获取模型列表。', 'success');
    }

    if (formScope === 'panel') {
        setPanelOpen(true);
    }
    renderAll();
}

/**
 * 处理测试按钮，未保存的表单会先保存再执行测试。
 * @param {Element} actionElement 触发按钮。
 * @param {string} providerId 服务商 ID。
 */
async function handleTestAction(actionElement, providerId) {
    const form = actionElement.closest('[data-akm-provider-form]');
    if (form instanceof HTMLFormElement) {
        await saveProviderFromForm(form, { afterSave: 'test' });
        return;
    }

    await testCurrentModel(providerId || getActiveProvider()?.id || '');
}

/**
 * 测试当前选中的模型是否能完成一次最小聊天补全。
 * @param {string} providerId 服务商 ID。
 */
async function testCurrentModel(providerId) {
    const provider = getProviderById(providerId);
    if (!provider) {
        return;
    }

    const testProvider = createProviderSnapshot(provider);
    const testedModel = testProvider.activeModel;

    if (!testedModel) {
        notify('请先选择模型，或添加自定义模型名后再测试。', 'warning');
        return;
    }

    state.testingProviders.add(provider.id);
    renderSoon();

    let result = { ok: false, message: '测试未完成。' };
    try {
        result = await requestCurrentModelCompletion(testProvider);
    } finally {
        state.testingProviders.delete(provider.id);
    }

    const current = getProviderById(provider.id);
    if (!current) {
        renderAll();
        return;
    }

    current.lastTestStatus = result.ok ? 'success' : 'error';
    current.lastTestMessage = result.ok
        ? `当前模型测试成功：${testedModel}`
        : `当前模型测试失败：${result.message}`;
    current.updatedAt = new Date().toISOString();
    saveSettingsDebounced();

    notify(current.lastTestMessage, result.ok ? 'success' : 'error');
    renderAll();
}

/**
 * 创建测试用的服务快照，避免异步测试期间用户切换模型导致结果串台。
 * @param {Record<string, unknown>} provider 当前服务配置。
 * @returns {Record<string, unknown>} 测试快照。
 */
function createProviderSnapshot(provider) {
    return {
        ...provider,
        models: Array.isArray(provider.models) ? [...provider.models] : [],
        customModels: Array.isArray(provider.customModels) ? [...provider.customModels] : [],
        activeModel: String(provider.activeModel || '').trim(),
        baseUrl: String(provider.baseUrl || '').trim(),
        includeHeaders: String(provider.includeHeaders || '').trim(),
        includeBody: String(provider.includeBody || '').trim(),
        excludeBody: String(provider.excludeBody || '').trim(),
        promptPostProcessing: normalizePromptPostProcessing(provider.promptPostProcessing),
        secretId: String(provider.secretId || '').trim(),
    };
}

/**
 * 通过 SillyTavern 后端对当前模型发起最小聊天补全请求。
 * @param {Record<string, string|string[]>} provider LLM 服务配置。
 * @returns {Promise<{ok: boolean, message: string}>} 测试结果。
 */
async function requestCurrentModelCompletion(provider) {
    try {
        const includeBodyValidation = validateManagedIncludeBody(provider.includeBody || '');
        if (!includeBodyValidation.ok) {
            throw new Error(includeBodyValidation.message);
        }

        if (provider.id === ensureSettings().activeProviderId) {
            await applyProvider(provider, 'test-current-model');
        }

        const response = await fetchWithTimeout('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: CUSTOM_SOURCE,
                custom_url: provider.baseUrl,
                custom_include_headers: provider.includeHeaders || '',
                custom_include_body: provider.includeBody || '',
                custom_exclude_body: provider.excludeBody || '',
                custom_prompt_post_processing: normalizePromptPostProcessing(provider.promptPostProcessing),
                secret_id: provider.secretId,
                reverse_proxy: '',
                proxy_password: '',
                model: provider.activeModel,
                messages: [
                    { role: 'user', content: 'Reply with OK.' },
                ],
                temperature: 0,
                max_tokens: 8,
                stream: false,
            }),
            cache: 'no-cache',
        }, MODEL_TEST_TIMEOUT_MS, '当前模型测试');

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }

        const payload = await response.json();
        if (payload?.error) {
            throw new Error(payload.error.message || '服务返回错误。');
        }

        return { ok: true, message: '' };
    } catch (error) {
        return { ok: false, message: getErrorMessage(error) };
    }
}

/**
 * 从 SillyTavern 后端请求 OpenAI-compatible 服务商的模型列表。
 * @param {string} providerId 服务商 ID。
 * @param {{apply?: boolean, notifySuccess?: boolean, reason?: string}} options 同步选项。
 * @returns {Promise<{ok: boolean, count: number, message: string}>} 同步结果。
 */
async function refreshProviderModels(providerId, options = {}) {
    const provider = getProviderById(providerId);
    if (!provider) {
        return { ok: false, count: 0, message: '未找到服务商。' };
    }

    if (!provider.baseUrl || !provider.secretId) {
        const message = '请先保存 Base URL 和 API Key。';
        provider.modelFetchError = message;
        saveSettingsDebounced();
        renderAll();
        return { ok: false, count: 0, message };
    }

    state.modelRequests.add(provider.id);
    provider.modelFetchError = '';
    renderSoon();

    try {
        const response = await fetchWithTimeout('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: CUSTOM_SOURCE,
                custom_url: provider.baseUrl,
                custom_include_headers: provider.includeHeaders || '',
                reverse_proxy: '',
                proxy_password: '',
                secret_id: provider.secretId,
            }),
            cache: 'no-cache',
        }, MODEL_FETCH_TIMEOUT_MS, '模型获取');

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }

        const payload = await response.json();
        const models = extractModelIds(payload);
        if (payload?.error && models.length === 0) {
            throw new Error('服务商返回错误，未获取到模型。');
        }
        if (models.length === 0) {
            throw new Error('连接已返回，但响应中没有模型列表。');
        }

        const currentProvider = getProviderById(provider.id);
        if (!currentProvider) {
            return { ok: false, count: 0, message: '服务已被删除。' };
        }

        const customModels = Array.isArray(currentProvider.customModels) ? currentProvider.customModels : [];
        const mergedModels = uniqueModels([...models, ...customModels]);
        currentProvider.models = mergedModels;
        currentProvider.customModels = uniqueModels(customModels);
        currentProvider.modelsLoadedAt = new Date().toISOString();
        currentProvider.modelFetchError = '';
        if (!currentProvider.activeModel || !mergedModels.includes(currentProvider.activeModel)) {
            currentProvider.activeModel = mergedModels[0] || '';
        }
        currentProvider.updatedAt = new Date().toISOString();
        saveSettingsDebounced();

        const settings = ensureSettings();
        if (options.apply && settings.enabled && currentProvider.id === settings.activeProviderId) {
            await applyProvider(currentProvider, options.reason || 'refresh-models');
        }

        if (options.notifySuccess) {
            notify(`已获取 ${models.length} 个模型。`, 'success');
        }

        return { ok: true, count: models.length, message: '' };
    } catch (error) {
        const message = getErrorMessage(error);
        const currentProvider = getProviderById(provider.id);
        if (currentProvider) {
            currentProvider.modelFetchError = message;
            currentProvider.updatedAt = new Date().toISOString();
        }
        saveSettingsDebounced();
        notify(`模型获取失败：${message}`, 'error');
        return { ok: false, count: 0, message };
    } finally {
        state.modelRequests.delete(provider.id);
        renderAll();
    }
}

/**
 * 激活服务商并写回 SillyTavern 连接状态。
 * @param {string} providerId 服务商 ID。
 */
async function activateProvider(providerId) {
    const settings = ensureSettings();
    const provider = getProviderById(providerId);
    if (!provider) {
        return;
    }

    settings.activeProviderId = provider.id;
    state.editingProviderId = provider.id;
    state.panelEditorOpen = false;
    saveSettingsDebounced();
    if (settings.enabled) {
        await applyProvider(provider, 'activate-provider');
    }
    renderAll();
}

/**
 * 激活当前服务商的某个模型。
 * @param {string} model 模型名称。
 * @param {string|null} providerId 指定服务商 ID，为空时使用当前服务商。
 */
async function activateModel(model, providerId = null) {
    const provider = providerId ? getProviderById(providerId) : getActiveProvider();
    const value = String(model || '').trim();
    if (!provider || !value) {
        return;
    }

    if (Array.isArray(provider.models) && provider.models.length > 0 && !provider.models.includes(value)) {
        notify('模型不在已获取列表中，请先重新获取模型。', 'warning');
        return;
    }

    provider.activeModel = value;
    provider.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    const settings = ensureSettings();
    if (settings.enabled && provider.id === settings.activeProviderId) {
        await applyProvider(provider, 'activate-model');
    }
    renderAll();
}

/**
 * 将用户输入的自定义模型名加入当前 LLM 服务，并立即切换到该模型。
 * @param {string} providerId 服务 ID。
 * @param {Element} sourceElement 触发输入或按钮。
 */
async function addCustomModel(providerId, sourceElement) {
    const provider = getProviderById(providerId);
    if (!provider) {
        notify('请先保存 LLM 服务，再添加自定义模型。', 'warning');
        return;
    }

    const row = sourceElement.closest?.('.akm-custom-model-row');
    const input = row?.querySelector?.('[data-akm-custom-model-input]');
    if (!(input instanceof HTMLInputElement)) {
        return;
    }

    const model = input.value.trim();
    if (!model) {
        notify('请输入自定义模型名。', 'warning');
        return;
    }

    provider.customModels = uniqueModels([...(Array.isArray(provider.customModels) ? provider.customModels : []), model]);
    provider.models = uniqueModels([...(Array.isArray(provider.models) ? provider.models : []), model]);
    provider.activeModel = model;
    provider.updatedAt = new Date().toISOString();
    input.value = '';
    saveSettingsDebounced();

    const settings = ensureSettings();
    if (settings.enabled && provider.id === settings.activeProviderId) {
        await applyProvider(provider, 'add-custom-model');
    }

    notify('自定义模型已加入列表并切换。', 'success');
    renderAll();
}

/**
 * 删除服务商和对应 secret。
 * @param {string} providerId 服务商 ID。
 */
async function deleteProvider(providerId) {
    const settings = ensureSettings();
    const provider = getProviderById(providerId);
    if (!provider) {
        return;
    }

    const confirmed = await confirmAction('删除 LLM 服务', `确定删除「${provider.name}」吗？`);
    if (!confirmed) {
        return;
    }

    if (provider.secretId) {
        await deleteSecret(SECRET_KEYS.CUSTOM, provider.secretId);
    }

    settings.providers = settings.providers.filter(item => item.id !== provider.id);
    settings.activeProviderId = settings.providers[0]?.id || null;
    state.editingProviderId = settings.activeProviderId;
    state.panelEditorOpen = false;
    saveSettingsDebounced();

    const nextProvider = getActiveProvider();
    if (nextProvider) {
        await applyProvider(nextProvider, 'delete-provider');
    } else {
        clearManagedConnection('delete-last-provider');
    }

    notify('LLM 服务已删除。', 'success');
    renderAll();
}

/**
 * 将插件当前服务商应用到 SillyTavern 原连接字段。
 * @param {Record<string, string|string[]>} provider 服务商配置。
 * @param {string} reason 应用原因，用于调试定位。
 */
async function applyProvider(provider, reason) {
    if (!provider || !ensureSettings().enabled) {
        return;
    }

    const includeBodyValidation = validateManagedIncludeBody(provider.includeBody || '');
    if (!includeBodyValidation.ok) {
        notify(includeBodyValidation.message, 'error');
        return;
    }

    state.pluginApplying = true;
    document.getElementById('akm-root')?.classList.add('akm-applying');

    try {
        ensureMainApiOpenAi();
        oai_settings.bind_preset_to_connection = false;
        $('#bind_preset_to_connection').prop('checked', false).trigger('input', { source: EXTENSION_ID, reason });

        if (provider.secretId) {
            await rotateSecret(SECRET_KEYS.CUSTOM, String(provider.secretId));
        }

        oai_settings.chat_completion_source = CUSTOM_SOURCE;
        $('#chat_completion_source').val(CUSTOM_SOURCE).trigger('change', { source: EXTENSION_ID, reason });

        oai_settings.custom_url = String(provider.baseUrl || '').trim();
        $('#custom_api_url_text').val(oai_settings.custom_url).trigger('input', { source: EXTENSION_ID, reason });

        oai_settings.custom_model = String(provider.activeModel || '').trim();
        $('#custom_model_id').val(oai_settings.custom_model).trigger('input', { source: EXTENSION_ID, reason });

        oai_settings.custom_include_headers = String(provider.includeHeaders || '').trim();
        $('#custom_include_headers').val(oai_settings.custom_include_headers).trigger('input', { source: EXTENSION_ID, reason });

        oai_settings.custom_include_body = String(provider.includeBody || '').trim();
        $('#custom_include_body').val(oai_settings.custom_include_body).trigger('input', { source: EXTENSION_ID, reason });

        oai_settings.custom_exclude_body = String(provider.excludeBody || '').trim();
        $('#custom_exclude_body').val(oai_settings.custom_exclude_body).trigger('input', { source: EXTENSION_ID, reason });

        oai_settings.custom_prompt_post_processing = normalizePromptPostProcessing(provider.promptPostProcessing);
        $('#custom_prompt_post_processing').val(oai_settings.custom_prompt_post_processing).trigger('change', { source: EXTENSION_ID, reason });

        $('#api_key_custom').val('');
        saveSettingsDebounced();
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 应用服务商失败：${reason}`, error);
        notify('LLM 服务应用失败，请查看浏览器控制台。', 'error');
    } finally {
        state.pluginApplying = false;
        document.getElementById('akm-root')?.classList.remove('akm-applying');
        hideNativeManagers();
        renderSoon();
    }
}

/**
 * 删除最后一个服务商时清空插件托管的连接字段，避免原界面残留旧地址和模型。
 * @param {string} reason 清理原因。
 */
function clearManagedConnection(reason) {
    state.pluginApplying = true;

    try {
        ensureMainApiOpenAi();
        oai_settings.bind_preset_to_connection = false;
        oai_settings.chat_completion_source = CUSTOM_SOURCE;
        oai_settings.custom_url = '';
        oai_settings.custom_model = '';
        oai_settings.custom_include_headers = '';
        oai_settings.custom_include_body = '';
        oai_settings.custom_exclude_body = '';
        oai_settings.custom_prompt_post_processing = custom_prompt_post_processing_types.NONE;

        $('#bind_preset_to_connection').prop('checked', false).trigger('input', { source: EXTENSION_ID, reason });
        $('#chat_completion_source').val(CUSTOM_SOURCE).trigger('change', { source: EXTENSION_ID, reason });
        $('#custom_api_url_text').val('').trigger('input', { source: EXTENSION_ID, reason });
        $('#custom_model_id').val('').trigger('input', { source: EXTENSION_ID, reason });
        $('#custom_include_headers').val('').trigger('input', { source: EXTENSION_ID, reason });
        $('#custom_include_body').val('').trigger('input', { source: EXTENSION_ID, reason });
        $('#custom_exclude_body').val('').trigger('input', { source: EXTENSION_ID, reason });
        $('#custom_prompt_post_processing').val(custom_prompt_post_processing_types.NONE).trigger('change', { source: EXTENSION_ID, reason });
        $('#api_key_custom').val('');
        saveSettingsDebounced();
    } finally {
        state.pluginApplying = false;
        hideNativeManagers();
    }
}

/**
 * 将主 API 切到 Chat Completion。
 */
function ensureMainApiOpenAi() {
    const mainApi = $('#main_api');
    if (mainApi.length > 0 && mainApi.val() !== 'openai') {
        mainApi.val('openai').trigger('change', { source: EXTENSION_ID });
    }
}

/**
 * 延迟修复原界面对连接字段的覆盖。
 * @param {string} reason 修复原因。
 */
function scheduleRepair(reason) {
    if (state.pluginApplying) {
        return;
    }

    const settings = ensureSettings();
    if (!settings.enabled || !settings.lockNativeConnection) {
        return;
    }

    clearTimeout(state.repairTimer);
    state.repairTimer = setTimeout(async () => {
        const provider = getActiveProvider();
        if (provider && isConnectionDrifted(provider)) {
            await applyProvider(provider, reason);
        }
    }, 80);
}

/**
 * 判断原连接状态是否偏离插件当前服务商。
 * @param {Record<string, string|string[]>} provider 服务商配置。
 * @returns {boolean} 是否需要修复。
 */
function isConnectionDrifted(provider) {
    const mainApi = readControlValue('#main_api');
    const source = readControlValue('#chat_completion_source', oai_settings.chat_completion_source);
    const baseUrl = readControlValue('#custom_api_url_text', oai_settings.custom_url);
    const model = readControlValue('#custom_model_id', oai_settings.custom_model);
    const includeHeaders = readControlValue('#custom_include_headers', oai_settings.custom_include_headers);
    const includeBody = readControlValue('#custom_include_body', oai_settings.custom_include_body);
    const excludeBody = readControlValue('#custom_exclude_body', oai_settings.custom_exclude_body);
    const promptPostProcessing = readControlValue('#custom_prompt_post_processing', oai_settings.custom_prompt_post_processing);
    const bindPresetControl = $('#bind_preset_to_connection');
    const presetBound = bindPresetControl.length > 0
        ? Boolean(bindPresetControl.prop('checked'))
        : Boolean(oai_settings.bind_preset_to_connection);

    if (
        mainApi !== 'openai'
        || source !== CUSTOM_SOURCE
        || baseUrl !== provider.baseUrl
        || model !== provider.activeModel
        || includeHeaders !== String(provider.includeHeaders || '').trim()
        || includeBody !== String(provider.includeBody || '').trim()
        || excludeBody !== String(provider.excludeBody || '').trim()
        || promptPostProcessing !== normalizePromptPostProcessing(provider.promptPostProcessing)
        || presetBound
    ) {
        return true;
    }

    const savedSecrets = secret_state[SECRET_KEYS.CUSTOM];
    const activeSecret = Array.isArray(savedSecrets) ? savedSecrets.find(secret => secret.active) : null;
    return Boolean(provider.secretId && activeSecret?.id && activeSecret.id !== provider.secretId);
}

/**
 * 获取当前服务商。
 * @returns {Record<string, string|string[]>|null} 当前服务商。
 */
function getActiveProvider() {
    const settings = ensureSettings();
    return getProviderById(settings.activeProviderId);
}

/**
 * 获取当前表单正在编辑的服务；新增模式返回空。
 * @returns {Record<string, string|string[]>|null} 正在编辑的服务配置。
 */
function getEditingProvider() {
    if (state.editingProviderId === NEW_PROVIDER_ID) {
        return null;
    }

    return getProviderById(state.editingProviderId);
}

/**
 * 按 ID 获取服务商。
 * @param {string|null} providerId 服务商 ID。
 * @returns {Record<string, string|string[]>|null} 服务商配置。
 */
function getProviderById(providerId) {
    if (!providerId) {
        return null;
    }

    const settings = ensureSettings();
    return settings.providers.find(provider => provider.id === providerId) || null;
}

/**
 * 打开或关闭悬浮面板。
 */
function togglePanel() {
    const settings = ensureSettings();
    settings.ui.panelOpen = !settings.ui.panelOpen;
    if (!settings.ui.panelOpen) {
        state.panelEditorOpen = false;
    }
    saveSettingsDebounced();
    renderAll();
}

/**
 * 设置悬浮面板开关状态。
 * @param {boolean} open 是否打开。
 */
function setPanelOpen(open) {
    const settings = ensureSettings();
    settings.ui.panelOpen = open;
    saveSettingsDebounced();
    renderAll();
}

/**
 * 启用或停用 LLM 管理控制台接管。
 * @param {boolean} enabled 是否启用。
 */
async function setConsoleEnabled(enabled) {
    const settings = ensureSettings();
    settings.enabled = Boolean(enabled);
    settings.lockNativeConnection = settings.enabled;
    saveSettingsDebounced();

    if (!settings.enabled) {
        state.panelEditorOpen = false;
        restoreNativeManagers();
        notify('LLM 管理控制台已停用，原 API 连接页已恢复。', 'info');
        renderAll();
        return;
    }

    hideNativeManagers();
    const activeProvider = getActiveProvider();
    if (activeProvider) {
        await applyProvider(activeProvider, 'enable-console');
    }
    notify('LLM 管理控制台已启用，原 API 连接页已接管。', 'success');
    renderAll();
}

/**
 * 应用用户保存的悬浮入口位置。
 * @param {HTMLElement} root 悬浮根节点。
 * @param {typeof DEFAULT_SETTINGS} settings 扩展设置。
 */
function applyRootPosition(root, settings) {
    const position = settings.ui.position;
    if (!position) {
        root.style.left = '';
        root.style.top = '';
        root.style.right = '';
        root.style.bottom = '';
        return;
    }

    const nextPosition = clampRootPosition(position.left, position.top, root);
    root.style.left = `${nextPosition.left}px`;
    root.style.top = `${nextPosition.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
}

/**
 * 把悬浮入口限制在视口内，避免拖出屏幕后无法找回。
 * @param {number} left 左侧像素。
 * @param {number} top 顶部像素。
 * @param {HTMLElement} root 悬浮根节点。
 * @returns {{left: number, top: number}} 修正后的位置。
 */
function clampRootPosition(left, top, root) {
    const margin = 8;
    const width = Math.max(root.offsetWidth || 58, 58);
    const height = Math.max(root.offsetHeight || 58, 58);
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    return {
        left: Math.min(Math.max(Number(left) || margin, margin), maxLeft),
        top: Math.min(Math.max(Number(top) || margin, margin), maxTop),
    };
}

/**
 * 折叠或展开完整配置区，降低扩展设置页里的视觉噪声。
 */
function toggleSettingsCollapsed() {
    const settings = ensureSettings();
    settings.ui.settingsCollapsed = !settings.ui.settingsCollapsed;
    saveSettingsDebounced();
    renderAll();
}

/**
 * 聚焦配置区表单。
 */
function focusProviderForm(scope = 'settings') {
    if (scope !== 'panel') {
        ensureSettings().ui.settingsCollapsed = false;
        saveSettingsDebounced();
        renderAll();
    }

    const suffix = scope === 'panel' ? 'panel' : 'settings';
    const formElement = document.getElementById(`akm-provider-form-${suffix}`);
    formElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => document.getElementById(`akm-provider-name-${suffix}`)?.focus(), 120);
}

/**
 * 弹出确认框。
 * @param {string} title 标题。
 * @param {string} message 内容。
 * @returns {Promise<boolean>} 用户是否确认。
 */
async function confirmAction(title, message) {
    if (Popup?.show?.confirm) {
        return Boolean(await Popup.show.confirm(title, message));
    }

    return window.confirm(`${title}\n${message}`);
}

/**
 * 发出用户可见提示。
 * @param {string} message 提示内容。
 * @param {'success'|'info'|'warning'|'error'} type 提示类型。
 */
function notify(message, type = 'info') {
    if (window.toastr?.[type]) {
        window.toastr[type](message, DISPLAY_NAME);
        return;
    }

    console.log(`[${DISPLAY_NAME}] ${message}`);
}

/**
 * 规范化保存的悬浮位置，过滤旧版本或异常配置。
 * @param {unknown} position 原始位置。
 * @returns {{left: number, top: number}|null} 可用位置。
 */
function normalizeSavedPosition(position) {
    if (!position || typeof position !== 'object') {
        return null;
    }

    const record = /** @type {{left?: unknown, top?: unknown}} */ (position);
    const left = Number(record.left);
    const top = Number(record.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
        return null;
    }

    return { left, top };
}

/**
 * 规范化提示词后处理配置，防止旧值或非法值污染连接状态。
 * @param {unknown} value 原始配置值。
 * @returns {string} SillyTavern 支持的配置值。
 */
function normalizePromptPostProcessing(value) {
    const allowedValues = new Set(Object.values(custom_prompt_post_processing_types));
    const normalized = String(value || '').trim();
    return allowedValues.has(normalized) ? normalized : custom_prompt_post_processing_types.NONE;
}

/**
 * 从不同 OpenAI-compatible `/models` 响应里提取模型 ID。
 * @param {unknown} payload 接口响应。
 * @returns {string[]} 模型 ID 列表。
 */
function extractModelIds(payload) {
    const lists = [];

    if (Array.isArray(payload)) {
        lists.push(payload);
    }

    if (payload && typeof payload === 'object') {
        const record = /** @type {Record<string, unknown>} */ (payload);
        if (Array.isArray(record.data)) {
            lists.push(record.data);
        }
        if (Array.isArray(record.models)) {
            lists.push(record.models);
        }

        if (record.data && typeof record.data === 'object') {
            const nested = /** @type {Record<string, unknown>} */ (record.data);
            if (Array.isArray(nested.data)) {
                lists.push(nested.data);
            }
            if (Array.isArray(nested.models)) {
                lists.push(nested.models);
            }
        }
    }

    const values = lists.flatMap(list => list.map(item => {
        if (typeof item === 'string') {
            return item;
        }

        if (!item || typeof item !== 'object') {
            return '';
        }

        const record = /** @type {Record<string, unknown>} */ (item);
        return String(record.id || record.name || '').replace(/^models\//, '');
    }));

    return uniqueModels(values).sort((left, right) => left.localeCompare(right));
}

/**
 * 取出异常的人类可读消息。
 * @param {unknown} error 异常对象。
 * @returns {string} 错误消息。
 */
function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    return String(error || '未知错误');
}

/**
 * 带超时执行浏览器请求，避免服务商无响应时界面长期停在加载状态。
 * @param {string} url 请求地址。
 * @param {RequestInit} options 请求选项。
 * @param {number} timeoutMs 超时时间。
 * @param {string} label 用户可读的请求名称。
 * @returns {Promise<Response>} 请求响应。
 */
async function fetchWithTimeout(url, options, timeoutMs, label) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (timedOut || error?.name === 'AbortError') {
            throw new Error(`${label}超时，请检查 Base URL、网络状态或服务商响应。`);
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

/**
 * 校验附加请求体不会覆盖控制台托管字段，确保模型选择和测试语义可信。
 * @param {string} includeBody 附加请求体文本。
 * @returns {{ok: boolean, message: string}} 校验结果。
 */
function validateManagedIncludeBody(includeBody) {
    const matchedKeys = findManagedIncludeBodyKeys(includeBody);
    if (matchedKeys.length === 0) {
        return { ok: true, message: '' };
    }

    return {
        ok: false,
        message: `附加请求体不能覆盖 ${matchedKeys.join('、')}。这些字段由 LLM 管理控制台托管，请通过模型选择或对应参数修改。`,
    };
}

/**
 * 提取附加请求体里会覆盖控制台状态的字段。
 * @param {string} includeBody 附加请求体文本。
 * @returns {string[]} 命中的托管字段。
 */
function findManagedIncludeBodyKeys(includeBody) {
    const value = String(includeBody || '').trim();
    if (!value) {
        return [];
    }

    const keys = new Set();
    const jsonKeys = readJsonIncludeBodyKeys(value);
    const candidateKeys = jsonKeys || readYamlLikeIncludeBodyKeys(value);
    for (const key of candidateKeys) {
        if (MANAGED_INCLUDE_BODY_KEYS.has(key)) {
            keys.add(key);
        }
    }

    return [...keys];
}

/**
 * 从 JSON 格式的附加请求体读取顶层字段。
 * @param {string} value 附加请求体文本。
 * @returns {string[]|null} 字段列表；无法作为 JSON 解析时返回 null。
 */
function readJsonIncludeBodyKeys(value) {
    try {
        const parsed = JSON.parse(value);
        return collectObjectKeys(parsed);
    } catch {
        return null;
    }
}

/**
 * 从 YAML 风格文本中保守识别对象字段。
 * @param {string} value 附加请求体文本。
 * @returns {string[]} 字段列表。
 */
function readYamlLikeIncludeBodyKeys(value) {
    const keys = [];
    for (const line of value.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:-\s*)?["']?([A-Za-z0-9_.$-]+)["']?\s*:/);
        if (match) {
            keys.push(match[1]);
        }
    }
    return keys;
}

/**
 * 收集对象或对象数组的顶层字段，匹配 SillyTavern 对附加请求体的合并方式。
 * @param {unknown} value 已解析的 JSON 值。
 * @returns {string[]} 顶层字段。
 */
function collectObjectKeys(value) {
    if (Array.isArray(value)) {
        return value.flatMap(item => collectObjectKeys(item));
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    return Object.keys(value);
}

/**
 * 读取原界面控件值，区分空字符串和控件不存在，避免清空后被旧设置掩盖。
 * @param {string} selector 控件选择器。
 * @param {unknown} fallback 控件不存在时使用的设置值。
 * @returns {string} 控件值。
 */
function readControlValue(selector, fallback = '') {
    const element = $(selector);
    if (element.length > 0) {
        const value = element.val();
        return Array.isArray(value)
            ? value.map(item => String(item || '').trim()).join(',')
            : String(value ?? '').trim();
    }

    return String(fallback ?? '').trim();
}

/**
 * 生成服务商唯一 ID。
 * @returns {string} 唯一 ID。
 */
function createId() {
    return window.crypto?.randomUUID?.() || uuidv4();
}

/**
 * 将模型列表去重并去掉空项。
 * @param {unknown[]} values 原始模型列表。
 * @returns {string[]} 规范化模型列表。
 */
function uniqueModels(values) {
    const seen = new Set();
    const models = [];

    for (const value of values) {
        const model = String(value || '').trim();
        if (!model || seen.has(model)) {
            continue;
        }

        seen.add(model);
        models.push(model);
    }

    return models;
}

/**
 * 生成悬浮球短名称。
 * @param {string} name 服务商名称。
 * @returns {string} 单字符短名称。
 */
function getShortName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        return 'A';
    }

    const compact = trimmed.replace(/\s+/g, '');
    const firstCharacter = Array.from(compact)[0] || 'A';
    return /^[a-z]$/i.test(firstCharacter) ? firstCharacter.toUpperCase() : firstCharacter;
}

/**
 * 转义 HTML 文本。
 * @param {unknown} value 原始值。
 * @returns {string} 转义后文本。
 */
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * 转义 HTML 属性。
 * @param {unknown} value 原始值。
 * @returns {string} 转义后属性值。
 */
function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
}
