/**
 * Zemismart TS1201 / _TZ3290_qazgdsae external converter.
 *
 * Upstream transport: zigbee-herdsman-converters/src/lib/zosung.ts
 * Audited revision: 9cb895488cd97fc21f89e9610a28b0fa4566e756
 * Dependencies tested: zigbee-herdsman-converters 26.105.0 and 26.109.0 (Node.js 24).
 * Upstream already has a generic TS1201 -> Tuya ZS06 fallback. This converter
 * adds exact Zemismart identification and working explicit learning stop.
 * Install ts1201-ir-codebooks.json beside this file. The local codebook supports
 * one-candidate-at-a-time AC matching; appliance response requires user confirmation.
 */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fzZosung, tzZosung, presetsZosung, zosungExtend} from 'zigbee-herdsman-converters/lib/zosung';
import {presets as e, access as ea} from 'zigbee-herdsman-converters/lib/exposes';
import * as store from 'zigbee-herdsman-converters/lib/store';
import {logger} from 'zigbee-herdsman-converters/lib/logger';

// Z2M 2.14.1 imports a temporary .mjs in the converter's own directory, so
// resolving this URL works for startup and hot reload without caching the JSON.
const codebooks = JSON.parse(readFileSync(new URL('./ts1201-ir-codebooks.json', import.meta.url), 'utf8'));
if (codebooks.schemaVersion !== 1 || !Array.isArray(codebooks.brands) || !Array.isArray(codebooks.candidates)) {
    throw new Error('Invalid TS1201 codebook schema; expected schemaVersion 1');
}
const brandsById = new Map();
const brandsByLabel = new Map();
for (const brand of codebooks.brands) {
    if (!brand.id || typeof brand.label !== 'string' || !brand.label || brandsById.has(brand.id) || brandsByLabel.has(brand.label)) {
        throw new Error('Invalid or duplicate TS1201 codebook brand');
    }
    brandsById.set(brand.id, brand);
    brandsByLabel.set(brand.label, brand);
}
const candidatesById = new Map();
const controlStates = new Map();
const isCode = (value) => typeof value === 'string' && value.length > 0 && value.length <= 65536 &&
    Buffer.from(value, 'base64').toString('base64') === value;
for (const candidate of codebooks.candidates) {
    if (!candidate.id || candidatesById.has(candidate.id) || !brandsById.has(candidate.brandId) ||
        typeof candidate.label !== 'string' || !candidate.label || candidate.test?.mode !== 'cool' ||
        !Number.isFinite(candidate.test?.temperature) || typeof candidate.test?.fan !== 'string' ||
        !isCode(candidate.test?.code) || !isCode(candidate.offCode)) {
        throw new Error(`Invalid TS1201 candidate: ${candidate.id ?? 'unknown'}`);
    }
    candidatesById.set(candidate.id, candidate);
    if (candidate.control) {
        const control = candidate.control;
        if (!Array.isArray(control.modes) || !control.modes.length || !Array.isArray(control.fans) || !control.fans.length ||
            !Array.isArray(control.states) || !control.states.length || !control.temperature || !control.defaults) {
            throw new Error(`Invalid TS1201 control capabilities: ${candidate.id}`);
        }
        const states = new Map();
        for (const state of control.states) {
            if (!control.modes.includes(state.mode) || !control.fans.includes(state.fan) ||
                (state.temperature !== null && !Number.isFinite(state.temperature)) || !isCode(state.code)) {
                throw new Error(`Invalid TS1201 control state: ${candidate.id}`);
            }
            const key = JSON.stringify([state.mode, state.temperature, state.fan]);
            if (states.has(key) && states.get(key).code !== state.code) throw new Error(`Conflicting control state: ${candidate.id}`);
            states.set(key, state);
        }
        controlStates.set(candidate.id, states);
    }
}
if (!brandsById.size || !candidatesById.size) throw new Error('TS1201 codebook is empty');

const META_KEY = 'ts1201IrQuickMatch';
const TRANSFER_KEY = 'zemismart_ts1201_transfer_v1';
const ACTION_LOCK = 'zemismart_ts1201_action_lock_v1';
const LAST_TX = 'zemismart_ts1201_last_tx_v1';
const SEND_TIMEOUT_MS = 30000;
const LEARN_TIMEOUT_MS = 60000;
const SEND_COOLDOWN_MS = 1500;
const NO_BRAND = '请选择品牌';
const NO_KEY = '请选择已保存按键';
const MAX_KEYS = 32;
const MAX_CAPTURE_BYTES = 16384;
const MAX_EXPANDED_BYTES = 131072;
const PENDING_LIFETIME_MS = 10 * 60 * 1000;
const isNamedKey = (key) => /^ir_key_[1-9]\d*$/.test(key);
const CAPTURE_MODULE_KEY = 'zemismart_ts1201_named_capture_module_v1';
const CAPTURE_GENERATION = randomUUID();
store.putValue(CAPTURE_MODULE_KEY, 'generation', CAPTURE_GENERATION);
const currentCapture = (transfer) => transfer.capture?.generation === CAPTURE_GENERATION &&
    store.getValue(CAPTURE_MODULE_KEY, 'generation', CAPTURE_GENERATION) === CAPTURE_GENERATION;
const keyDiscoveryRevisions = new Map();
// Only metadata publication/discovery callbacks and completed-pending timers
// survive a converter reload. No capture session or radio job is restored here.
function sharedKeyMap(name) {
    let values = store.getValue(CAPTURE_MODULE_KEY, name);
    if (!values) {
        values = new Map();
        store.putValue(CAPTURE_MODULE_KEY, name, values);
    }
    return values;
}
const keyActions = {
    ir_key_learn: ['开始按键学习', '先填写名称，再启动本次学习并按原遥控器；不会自动保存或重发'],
    ir_key_stop: ['停止按键学习', '停止当前学习；停止失败时可再次点击重试，不会发送已学习的红外码'],
    ir_key_save: ['确认保存新按键', '确认本次捕获来自您刚刚按下的遥控器后保存；同名不会覆盖'],
    ir_key_send: ['发送所选按键', '发送已保存的所选红外按键一次'],
    ir_key_update: ['更新所选按键编码', '确认本次新捕获的来源，显式替换所选按键的旧编码，保留原名称和 ID'],
    ir_key_rename: ['重命名所选按键', '使用名称输入框的新名称；保留按钮 ID 和原编码'],
    ir_key_delete: ['删除所选按键', '删除所选按键，可用撤销最近删除恢复；不发送红外'],
    ir_key_undo_delete: ['撤销最近删除', '恢复最近删除的按键及原按钮 ID；不发送红外'],
};
const keyProperties = new Set(['ir_key_name', 'ir_key_selected', 'ir_key_status', 'ir_key_count', ...Object.keys(keyActions)]);
const climateKeys = ['state', 'system_mode', 'occupied_heating_setpoint', 'fan_mode', 'ac_temperature_choice'];
const discoveryControls = new Map();
const buttons = {
    ac_match_start: ['开始匹配', '发送所选品牌第一套测试码；将按候选显示的制冷温度和风速开机'],
    ac_match_next: ['下一套码', '发送下一套测试码；将按候选显示的制冷温度和风速开机，不会自动循环'],
    ac_match_retry: ['重试当前码', '再次发送当前测试码；将按候选显示的制冷温度和风速开机'],
    ac_match_confirm: ['确认匹配成功', '仅在亲自确认空调响应正确后保存当前已测试码库；不发送红外'],
    ac_match_cancel: ['取消匹配', '取消当前选择流程，不发送新的红外码，保留此前已保存码库'],
    ac_saved_test: ['测试已保存码', '发送已保存码库的制冷开机测试码；温度和风速显示在匹配状态中'],
    ac_saved_off: ['关闭已匹配空调', '发送此前确认保存的码库关机码；是否实际关机需观察空调'],
};
const buttonKeys = new Set(['learn_ir_code', ...Object.keys(buttons), ...Object.keys(keyActions)]);
const deviceFor = (entity, meta) => meta?.device ?? entity.getDevice?.();
const stateFor = (device) => ({version: 1, selectedBrandId: null, candidateId: null, testedCandidateId: null,
    confirmedCodebookId: null, phase: 'idle', status: '请选择空调品牌，再按开始匹配；尚未确认匹配。',
    ...(device?.meta?.[META_KEY] ?? {})});
const bankFor = (device) => ({version: 1, revision: 0, nextId: 1, entries: [], selectedId: null, draftName: '', pending: null,
    learning: null, rawLearning: false, stopRequired: false, deleted: null,
    status: '填写按键名称并点击学习新按键；旧学习码不会自动加入按键库。',
    ...(stateFor(device).keyBank ?? {})});
function validateKeyName(value) {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 48 ||
        /[\u0000-\u001f\u007f]/.test(value) || value.trim() === NO_KEY) throw new Error('按键名称须为 1–48 个字符，不能包含控制字符或使用占位名称');
    return value.trim();
}
function freshPending(bank) {
    const pending = bank.pending;
    return pending?.validated === true && typeof pending.captureId === 'string' &&
        Number.isFinite(pending.capturedAt) && Date.now() >= pending.capturedAt &&
        Date.now() - pending.capturedAt < PENDING_LIFETIME_MS && isCode(pending.code);
}
function relevantKeyActions(bank) {
    const selected = bank.entries.some((entry) => entry.id === bank.selectedId);
    const result = ['ir_key_learn'];
    if (bank.learning || bank.rawLearning || bank.stopRequired) result.push('ir_key_stop');
    if (freshPending(bank)) {
        if (bank.entries.length < MAX_KEYS) result.push('ir_key_save');
        if (selected) result.push('ir_key_update');
    }
    if (selected) result.push('ir_key_send', 'ir_key_rename', 'ir_key_delete');
    if (bank.deleted && bank.entries.length < MAX_KEYS && !bank.entries.some((entry) =>
        entry.id === bank.deleted.entry.id || entry.name === bank.deleted.entry.name)) result.push('ir_key_undo_delete');
    return result;
}
const keyLayout = (bank) => JSON.stringify([bank.entries.map(({id, name}) => [id, name]), relevantKeyActions(bank)]);
function rememberKeyContext(entity, meta) {
    if (store.getValue(CAPTURE_MODULE_KEY, 'generation') === undefined) store.putValue(CAPTURE_MODULE_KEY, 'generation', CAPTURE_GENERATION);
    const device = deviceFor(entity, meta);
    if (device?.ieeeAddr) {
        const contexts = sharedKeyMap('contexts');
        const previous = contexts.get(device.ieeeAddr);
        contexts.set(device.ieeeAddr, {device, publish: meta?.publish ?? previous?.publish,
            deviceExposesChanged: meta?.deviceExposesChanged ?? previous?.deviceExposesChanged});
    }
}
function scheduleKeyExpiry(device) {
    const id = device?.ieeeAddr;
    if (!id) return;
    const timers = sharedKeyMap('expiryTimers');
    clearTimeout(timers.get(id));
    timers.delete(id);
    const pending = bankFor(device).pending;
    if (!freshPending(bankFor(device))) return;
    const timer = setTimeout(() => {
        if (timers.get(id) !== timer) return;
        timers.delete(id);
        if (store.getValue(CAPTURE_MODULE_KEY, 'generation') !== CAPTURE_GENERATION ||
            bankFor(device).pending?.captureId !== pending.captureId) return;
        void saveBank(device, {pending: null, revision: bankFor(device).revision + 1,
            status: '待保存的新码已超过 10 分钟，请重新学习；已保存按键不变。'})
            .then((state) => sharedKeyMap('contexts').get(id)?.publish?.(state))
            .catch((error) => logger.error(`TS1201 pending expiry could not be saved: ${error.message}`, 'zhc:zemismart:ts1201'));
    }, Math.max(1, pending.capturedAt + PENDING_LIFETIME_MS - Date.now()));
    timer.unref?.();
    timers.set(id, timer);
}
function bankSnapshot(device) {
    const bank = bankFor(device);
    return {
        ir_key_name: bank.draftName,
        ir_key_selected: bank.entries.find((entry) => entry.id === bank.selectedId)?.name ?? NO_KEY,
        ir_key_count: bank.entries.length,
        ir_key_status: (bank.pending && !freshPending(bank) ? '待保存的新码已失效或超过 10 分钟，请重新学习；已保存按键不变。' : bank.status).slice(0, 250),
    };
}
async function saveBank(device, patch) {
    const previous = bankFor(device);
    const next = {...previous, ...patch};
    const changed = keyLayout(previous) !== keyLayout(next);
    if (changed) next.revision = Math.max(previous.revision + 1, next.revision);
    const result = await saveState(device, {keyBank: next});
    scheduleKeyExpiry(device);
    if (changed || next.revision !== previous.revision) sharedKeyMap('contexts').get(device.ieeeAddr)?.deviceExposesChanged?.();
    return result;
}
function assertSingleKeyOperation(meta, key) {
    const requested = Object.keys(meta?.message ?? {}).filter((name) => keyProperties.has(name) || isNamedKey(name));
    if (new Set([...requested, key]).size > 1) throw new Error('请一次执行一个按键库操作，先设置名称/选择，再点击动作');
}
function assertBankIdle(entity) {
    if (activeTransfer(entity)) throw new Error('红外正在学习或传输，请完成或停止后管理按键');
}
// Validate the complete FastLZ-style learned stream. The upstream convenience
// decoder tolerates truncated input, which is unsuitable for saving a new key.
function validateLearnedStream(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_CAPTURE_BYTES) throw new Error('学习码长度无效');
    const expanded = [];
    let position = 0;
    const take = () => {
        if (position >= raw.length) throw new Error('学习码压缩流被截断');
        return raw[position++];
    };
    while (position < raw.length) {
        const header = take();
        const kind = header >> 5;
        let length = kind === 0 ? (header & 31) + 1 : kind + 2;
        if (kind === 7) {
            let extension;
            do { extension = take(); length += extension; } while (extension === 255);
        }
        if (expanded.length + length > MAX_EXPANDED_BYTES) throw new Error('学习码解压后过长');
        if (kind === 0) {
            for (let i = 0; i < length; i++) expanded.push(take());
        } else {
            const distance = ((header & 31) << 8) + take() + 1;
            if (distance > expanded.length) throw new Error('学习码压缩引用无效');
            for (let i = 0; i < length; i++) expanded.push(expanded[expanded.length - distance]);
        }
    }
    if (expanded.length < 4 || expanded.length % 2 || !expanded.some((byte) => byte !== 0)) throw new Error('学习码不包含完整有效的红外时序');
}
const confirmedCandidate = (device) => candidatesById.get(stateFor(device).confirmedCodebookId);
const modeConstraints = (candidate, mode) => candidate.control.modeConstraints?.[mode] ?? {};
function temperatureProfile(candidate, mode) {
    const constraints = modeConstraints(candidate, mode);
    const values = [...(constraints.temperatureApplicable !== false && constraints.temperatures?.length ?
        constraints.temperatures : candidate.control.temperature.values)].sort((a, b) => a - b);
    const delta = values.length > 1 ? values[1] - values[0] : candidate.control.temperature.step;
    const step = delta > 0 && values.every((value, index) => !index || Math.abs(value - values[index - 1] - delta) < 1e-6) ? delta : null;
    return {values, min: values[0], max: values.at(-1), step};
}
const initialClimate = (candidate) => {
    const initial = {power: true, mode: candidate.test.mode, temperature: candidate.test.temperature, fan: candidate.test.fan};
    return {codebookId: candidate.id, desired: initial, estimated: {...initial}, estimateStale: false,
        status: '根据已确认试机设置初始化；仅为红外命令估计，未读取空调实际状态。'};
};
const climateFor = (device) => {
    const candidate = confirmedCandidate(device);
    if (!candidate?.control) return null;
    const existing = stateFor(device).climate;
    if (existing?.codebookId === candidate.id) return existing;
    // Migration and new confirmation are local only: the confirmed quick-match
    // test is the initial command estimate, never a live temperature report.
    return initialClimate(candidate);
};
function climateSnapshot(device) {
    const climate = climateFor(device);
    if (!climate) return {ac_control_status: stateFor(device).confirmedCodebookId ?
        '此已保存码库尚无完整控制表；仍可使用已保存试机、关机或手动红外。' : '请先匹配并确认保存空调码库，随后显示温度、模式、风速与电源控制。'};
    return {
        state: climate.estimated.power ? 'ON' : 'OFF',
        system_mode: climate.estimated.power ? climate.estimated.mode : 'off',
        occupied_heating_setpoint: climate.desired.temperature,
        fan_mode: climate.desired.fan,
        ac_temperature_choice: String(climate.desired.temperature),
        ac_estimate_stale: Boolean(climate.estimateStale),
        ac_control_status: climate.status.slice(0, 250),
    };
}
async function markClimateStale(device, reason) {
    const climate = climateFor(device);
    if (!climate) return;
    return saveState(device, {climate: {...climate, estimateStale: true, status: reason}});
}
function lookupControl(candidate, desired) {
    const constraint = modeConstraints(candidate, desired.mode);
    const temperature = constraint.temperatureApplicable === false ? null : desired.temperature;
    const result = controlStates.get(candidate.id)?.get(JSON.stringify([desired.mode, temperature, desired.fan]));
    if (!result) throw new Error(`此码库不支持 ${desired.mode} / ${temperature ?? '无控温'} / ${desired.fan}；请使用列表中支持的组合`);
    return result;
}
function controlDescription(desired, candidate) {
    const constraint = modeConstraints(candidate, desired.mode);
    return `${desired.mode} / ${constraint.temperatureApplicable === false ? '不控温' : `${desired.temperature}℃`} / ${
        constraint.fanControllable === false ? '模式管理风速' : `风速 ${desired.fan}`}`;
}
async function ensureClimate(device, entity) {
    const climate = climateFor(device);
    if (climate && stateFor(device).climate?.codebookId !== climate.codebookId) await saveState(device, {climate});
    if (climate?.pending && entity && !activeTransfer(entity)) await saveState(device, {climate: {...climate, pending: false,
        status: '上次控制传输未确认完成；保留上次命令估计，不会自动重发。'}});
    return climate;
}
const candidatesFor = (brandId) => codebooks.candidates.filter((candidate) => candidate.brandId === brandId);
const testAction = (candidate) => {
    const fan = {auto: '自动', low: '低', medium: '中', high: '高'}[candidate.test.fan] ?? candidate.test.fan;
    return `制冷 ${Number(candidate.test.temperature.toFixed(2))}℃ / ${fan}风`;
};
const describeCandidate = (candidate) => {
    const list = candidatesFor(candidate.brandId);
    return `${candidate.label.slice(0, 65)}（${list.findIndex((item) => item.id === candidate.id) + 1}/${list.length}），${testAction(candidate)}`;
};
const snapshot = (device) => {
    const state = stateFor(device);
    return {
        ac_brand: brandsById.get(state.selectedBrandId)?.label ?? NO_BRAND,
        ac_match_status: String(state.status).slice(0, 250),
        ac_match_candidate: state.candidateId ?? '',
        ac_saved_codebook: state.confirmedCodebookId ?? '',
        ...climateSnapshot(device),
        ...bankSnapshot(device),
    };
};
async function saveState(device, patch) {
    if (!device || typeof device.save !== 'function') throw new Error('Quick match requires a paired Zigbee device');
    device.meta ??= {};
    const previous = device.meta[META_KEY];
    device.meta[META_KEY] = {...stateFor(device), ...patch};
    try {
        await device.save();
    } catch (error) {
        if (previous === undefined) delete device.meta[META_KEY];
        else device.meta[META_KEY] = previous;
        throw error;
    }
    return snapshot(device);
}
async function withActionLock(entity, action) {
    if (store.getValue(entity, ACTION_LOCK, false)) throw new Error('操作正在处理中，请勿重复点击');
    store.putValue(entity, ACTION_LOCK, true);
    try { return await action(); } finally { store.clearValue(entity, ACTION_LOCK); }
}
function withKeyAction(entity, meta, action) {
    return withActionLock(entity, action).catch((error) => {
        if (store.getValue(CAPTURE_MODULE_KEY, 'generation', CAPTURE_GENERATION) === CAPTURE_GENERATION) {
            const bank = bankFor(deviceFor(entity, meta));
            meta?.publish?.({ir_key_status: String(bank.stopRequired ? bank.status : error.message).slice(0, 250)});
        }
        throw error;
    });
}
const activeTransfer = (entity) => store.getValue(entity, TRANSFER_KEY);
function clearTransfer(entity, transfer) {
    clearTimeout(transfer.timer);
    transfer.capture?.resolveStart?.(false);
    if (activeTransfer(entity) !== transfer) return;
    store.clearValue(entity, TRANSFER_KEY);
    store.clearValue(entity, 'irMessageInfo');
}
function assertNotSending(entity) {
    const transfer = activeTransfer(entity);
    if (transfer && transfer.kind !== 'learning') throw new Error('红外传输尚未结束，请等待当前操作完成');
}
function assertCanSend(entity) {
    assertNotSending(entity);
    if (Date.now() - store.getValue(entity, LAST_TX, 0) < SEND_COOLDOWN_MS) {
        throw new Error('刚发送过红外码，请稍候再试，避免重复发送');
    }
}
async function failTransfer(entity, transfer, reason) {
    if (activeTransfer(entity) !== transfer) return;
    const wasLearning = transfer.kind === 'learning' || Boolean(transfer.capture);
    transfer.kind = 'finishing';
    try {
        let stopRequired = false;
        if (wasLearning) {
            transfer.capture?.resolveStart?.(false);
            try { await controlLearning(entity, 1); }
            catch { stopRequired = true; reason += '；停止学习未获确认，请再次点击停止按键学习'; }
        }
        if (activeTransfer(entity) !== transfer) return;
        if (transfer.device && (wasLearning || transfer.purpose === 'named_key')) {
            const state = await saveBank(transfer.device, wasLearning ? {learning: null, rawLearning: false, stopRequired, pending: null,
                status: `${reason}；本次未生成可保存的新按键。`} : {status: `${reason}；已保存按键未更改。`});
            transfer.publish?.(state);
        } else if (transfer.device && transfer.purpose && !transfer.cancelled) {
            const state = await saveState(transfer.device, transfer.purpose === 'climate' ? {
                climate: {...climateFor(transfer.device), pending: false, estimateStale: true,
                    status: `${reason}；保留上次估计状态，估计可能已过期，请观察空调。`},
            } : {phase: 'error', testedCandidateId: null, status: `${reason}；未确认匹配，已保存码库不变。`});
            transfer.publish?.(state);
        } else if (transfer.device && !transfer.purpose) {
            if (transfer.transmissionAttempted) await markClimateStale(transfer.device,
                `${reason}；空调面板估计可能已过期，请观察实际状态。`);
            transfer.publish?.(snapshot(transfer.device));
        }
    } finally {
        clearTransfer(entity, transfer);
    }
}
function armTimeout(entity, transfer, duration) {
    transfer.timer = setTimeout(() => {
        if (transfer.capture && !currentCapture(transfer)) { clearTransfer(entity, transfer); return; }
        void failTransfer(entity, transfer, '等待设备传输完成超时，请检查设备后重试').catch((error) =>
            logger.error(`TS1201 timeout state could not be saved: ${error.message}`, 'zhc:zemismart:ts1201'));
    }, duration);
    transfer.timer.unref?.();
}
async function controlLearning(entity, study) {
    await entity.command('zosungIRControl', 'zosungControlIRCommand00',
        {data: Buffer.from(JSON.stringify({study}))}, {disableDefaultResponse: true});
}
async function startTransmission(entity, key, value, meta, context) {
    assertCanSend(entity);
    const previous = activeTransfer(entity);
    if (previous) clearTransfer(entity, previous);
    rememberKeyContext(entity, meta);
    const transfer = {kind: 'sending', device: deviceFor(entity, meta), publish: meta?.publish,
        sendChain: Promise.resolve(), acknowledgedBytes: 0, acknowledgedChunks: new Map(), ...context};
    store.putValue(entity, TRANSFER_KEY, transfer);
    armTimeout(entity, transfer, SEND_TIMEOUT_MS);
    let learningStopped = false;
    try {
        // Stop learning before any manual or quick-match transmission.
        await controlLearning(entity, 1);
        learningStopped = true;
        if (activeTransfer(entity) !== transfer || transfer.kind !== 'sending') throw new Error('本次发送已失效，请重新操作');
        if (previous || bankFor(transfer.device).stopRequired) await saveBank(transfer.device,
            {learning: null, rawLearning: false, stopRequired: false, pending: null,
            status: '按键学习已被本次发码操作停止，未生成新的待保存按键。'});
        // Consume the sequence even if the Zigbee acknowledgement fails: the
        // device may still have received the command. Persist it across restarts.
        const previousSeq = store.getValue(entity, 'seq', stateFor(transfer.device).transportSeq ?? -1);
        transfer.seq = (previousSeq + 1) % 0x10000;
        if (typeof transfer.device?.save === 'function') await saveState(transfer.device, {transportSeq: transfer.seq,
            ...(transfer.purpose !== 'match' && stateFor(transfer.device).phase === 'tested' ? {
                phase: 'idle', testedCandidateId: null, testedTransmissionSeq: null,
                status: '已开始发送其他指令；此前试机结果不能继续确认，重新匹配时请再次试机。已保存码库不变。',
            } : {})});
        store.putValue(entity, 'seq', previousSeq);
        store.putValue(entity, LAST_TX, Date.now());
        if (transfer.purpose !== 'climate') {
            const staleState = await markClimateStale(transfer.device,
                '正在发送其他红外指令；空调面板估计可能已过期，请观察实际状态。');
            if (staleState) transfer.publish?.(staleState);
        }
        if (activeTransfer(entity) !== transfer || transfer.kind !== 'sending') throw new Error('本次发送已失效，请重新操作');
        try {
            transfer.transmissionAttempted = true;
            await tzZosung.zosung_ir_code_to_send.convertSet(entity, key, value, meta);
        } finally {
            store.putValue(entity, 'seq', transfer.seq);
        }
    } catch (error) {
        if (!learningStopped && (previous || bankFor(transfer.device).stopRequired) &&
            activeTransfer(entity) === transfer && typeof transfer.device?.save === 'function') {
            await saveBank(transfer.device, {learning: null, rawLearning: false, pending: null, stopRequired: true,
                status: '发送前停止学习失败；没有发送红外码，请检查设备在线后再次点击停止按键学习。'});
        }
        await failTransfer(entity, transfer, `发送失败：${String(error.message).slice(0, 90)}`);
        throw error;
    }
}

const sendIrCode = {
    ...tzZosung.zosung_ir_code_to_send,
    convertSet: (entity, key, value, meta) => withActionLock(entity, () => startTransmission(entity, key, value, meta)),
};

async function setLearning(entity, study, meta, captureSession) {
    assertNotSending(entity);
    rememberKeyContext(entity, meta);
    const device = deviceFor(entity, meta);
    const previous = activeTransfer(entity);
    if (study === 0 && (previous || bankFor(device).stopRequired)) await setLearning(entity, 1, meta);
    if (previous) {
        previous.capture?.resolveStart?.(false);
        clearTransfer(entity, previous);
    }
    const persistent = device && typeof device.save === 'function';
    if (study === 1) {
        if (persistent) await saveBank(device, {pending: null, learning: null, rawLearning: false, stopRequired: true,
            status: '正在停止学习；等待设备确认，本次捕获已作废。'});
        try { await controlLearning(entity, study); }
        catch (error) {
            if (persistent) {
                const state = await saveBank(device, {stopRequired: true,
                    status: '停止学习命令失败；设备状态未知，请检查设备在线后再次点击停止按键学习。'});
                meta?.publish?.(state);
            }
            throw error;
        }
        return persistent ? {state: await saveBank(device, {stopRequired: false,
            status: '本次按键学习已停止，未生成可保存的新码。'})} : undefined;
    }
    if (persistent) await saveBank(device, {pending: null, learning: captureSession ?? null, rawLearning: !captureSession,
        stopRequired: false, status: captureSession ?
            `正在学习“${captureSession.name}”：请按原遥控器；收到完整新码后仍须确认来源并保存。` :
            '正在原始学习；只有开始按键学习流程可生成命名按键，可点击停止按键学习退出。'});
    const transfer = {kind: 'learning', device, publish: meta?.publish};
    if (captureSession) {
        transfer.capture = {...captureSession, generation: CAPTURE_GENERATION, header: null, received: 0, finishRequested: false};
        transfer.capture.startReady = new Promise((resolve) => { transfer.capture.resolveStart = resolve; });
        transfer.receiveChain = Promise.resolve();
    }
    store.putValue(entity, TRANSFER_KEY, transfer);
    armTimeout(entity, transfer, LEARN_TIMEOUT_MS);
    try {
        await controlLearning(entity, study);
        transfer.capture?.resolveStart?.(activeTransfer(entity) === transfer);
    } catch (error) {
        await failTransfer(entity, transfer, `开始学习失败：${String(error.message).slice(0, 70)}`);
        throw error;
    }
    return persistent ? {state: snapshot(device)} : undefined;
}

async function sendNamedKey(entity, device, entry, meta) {
    if (!entry || !isCode(entry.code)) throw new Error('该按键不存在或编码无效，请重新选择已保存按键');
    assertCanSend(entity);
    await saveBank(device, {status: `正在发送“${entry.name}”；不会自动更新空调模式、温度或电源估计。`});
    await startTransmission(entity, 'ir_code_to_send', entry.code, meta, {purpose: 'named_key', keyId: entry.id, keyName: entry.name});
    return {state: snapshot(device)};
}

const keyBankControl = {
    key: [...keyProperties],
    convertGet: async (entity, key, meta) => {
        rememberKeyContext(entity, meta);
        const device = deviceFor(entity, meta);
        const bank = bankFor(device);
        const transfer = activeTransfer(entity);
        if (transfer?.capture && !currentCapture(transfer)) clearTransfer(entity, transfer);
        if ((bank.learning && (!transfer?.capture || !currentCapture(transfer) || transfer.capture.id !== bank.learning.id)) ||
            (bank.rawLearning && transfer?.kind !== 'learning')) {
            await saveBank(device, {learning: null, rawLearning: false, stopRequired: true, pending: null,
                status: '上次按键学习已中断；请先停止学习后重试，没有自动学习或导入旧码。'});
        }
        scheduleKeyExpiry(device);
        meta?.publish?.(snapshot(device));
    },
    convertSet: (entity, key, value, meta) => withKeyAction(entity, meta, async () => {
        rememberKeyContext(entity, meta);
        assertSingleKeyOperation(meta, key);
        const device = deviceFor(entity, meta);
        if (!device || typeof device.save !== 'function') throw new Error('按键库需要已配对的 Zigbee 设备');
        const bank = bankFor(device);
        if (key in keyActions && (value === 'OFF' || value === false)) return {state: snapshot(device)};
        if (key in keyActions && value !== 'ON' && value !== true) throw new Error(`${key} accepts ON or true only`);
        const selected = bank.entries.find((entry) => entry.id === bank.selectedId);
        if (key === 'ir_key_stop') return setLearning(entity, 1, meta);
        if (key === 'ir_key_send') return sendNamedKey(entity, device, selected, meta);
        if (key === 'ir_key_learn') {
            assertNotSending(entity);
            const name = validateKeyName(bank.draftName);
            const session = {id: randomUUID(), startedAt: Date.now(), name};
            await setLearning(entity, 0, meta, session);
            return {state: snapshot(device)};
        }
        assertBankIdle(entity);
        if (key === 'ir_key_name') return {state: await saveBank(device, {draftName: validateKeyName(value)})};
        if (key === 'ir_key_selected') {
            const entry = bank.entries.find((item) => item.name === value);
            if (!entry && value !== NO_KEY) throw new Error('请选择当前按键列表中的名称');
            return {state: await saveBank(device, {selectedId: entry?.id ?? null, ...(entry ? {draftName: entry.name} : {})})};
        }
        if (!Object.hasOwn(keyActions, key)) throw new Error(`${key} is read-only`);
        let patch;
        if (key === 'ir_key_save' || key === 'ir_key_update') {
            if (!freshPending(bank)) throw new Error('没有本次流程验证通过且未过期的新码；请先学习新按键并确认其来源');
            if (key === 'ir_key_save') {
                const name = validateKeyName(bank.draftName);
                if (bank.entries.some((entry) => entry.name === name)) throw new Error('已有同名按键；请选择旧按键并显式更新编码，或使用新名称');
                if (bank.entries.length >= MAX_KEYS) throw new Error(`最多保存 ${MAX_KEYS} 个按键，请先删除不用的按键`);
                const id = Math.max(bank.nextId, ...bank.entries.map((entry) => entry.id + 1), (bank.deleted?.entry.id ?? 0) + 1);
                if (!Number.isSafeInteger(id) || id < 1) throw new Error('按键 ID 无效');
                const entry = {id, name, code: bank.pending.code, capturedAt: bank.pending.capturedAt};
                patch = {entries: [...bank.entries, entry], selectedId: id, nextId: id + 1, pending: null,
                    status: `已确认保存“${name}”；共 ${bank.entries.length + 1} 个按键，可直接点击命名按钮发送。`};
            } else {
                if (!selected) throw new Error('请先选择要更新的已保存按键');
                patch = {entries: bank.entries.map((entry) => entry.id === selected.id ?
                    {...entry, code: bank.pending.code, capturedAt: bank.pending.capturedAt} : entry), pending: null,
                    status: `已确认更新“${selected.name}”的编码，名称和按钮 ID 保持不变。`};
            }
        } else if (key === 'ir_key_rename') {
            if (!selected) throw new Error('请先选择要重命名的按键');
            const name = validateKeyName(bank.draftName);
            if (bank.entries.some((entry) => entry.id !== selected.id && entry.name === name)) throw new Error('已有同名按键，请使用不同名称');
            patch = {entries: bank.entries.map((entry) => entry.id === selected.id ? {...entry, name} : entry),
                status: `已重命名为“${name}”；原按钮 ID 和编码不变。`};
        } else if (key === 'ir_key_delete') {
            if (!selected) throw new Error('请先选择要删除的按键');
            patch = {entries: bank.entries.filter((entry) => entry.id !== selected.id), selectedId: null,
                deleted: {entry: {...selected}, index: bank.entries.findIndex((entry) => entry.id === selected.id)},
                status: `已删除“${selected.name}”；可撤销最近删除恢复同一按钮 ID。`};
        } else if (key === 'ir_key_undo_delete') {
            const deleted = bank.deleted;
            if (!deleted) throw new Error('没有可撤销的删除');
            if (bank.entries.length >= MAX_KEYS || bank.entries.some((entry) => entry.id === deleted.entry.id || entry.name === deleted.entry.name)) {
                throw new Error('无法恢复：按键已满或名称/ID 冲突，请先处理当前按键列表');
            }
            const entries = [...bank.entries];
            entries.splice(Math.min(deleted.index, entries.length), 0, {...deleted.entry});
            patch = {entries, selectedId: deleted.entry.id, draftName: deleted.entry.name, deleted: null,
                status: `已恢复“${deleted.entry.name}”及原按钮 ID。`};
        }
        const result = await saveBank(device, {...patch, revision: bank.revision + 1});
        return {state: result};
    }),
};

const namedKeyControl = {
    // Deliberate device-specific fallback: dynamic monotonic IDs must work after
    // reload and across multiple devices, without sharing a mutable key array.
    convertSet: (entity, key, value, meta) => withKeyAction(entity, meta, async () => {
        if (!isNamedKey(key)) throw new Error(`Unsupported property: ${key}`);
        assertSingleKeyOperation(meta, key);
        if (value !== '发送') throw new Error('命名按键仅接受“发送”动作');
        const device = deviceFor(entity, meta);
        const entry = bankFor(device).entries.find((item) => `ir_key_${item.id}` === key);
        return sendNamedKey(entity, device, entry, meta);
    }),
};

// Z2M 2.14.1 calls a converter object only once per incoming MQTT message.
// Keep all climate keys together and validate meta.message before any IR write.
const climateControl = {
    key: [...climateKeys, 'ac_control_status', 'ac_estimate_stale'],
    convertGet: async (entity, key, meta) => {
        const device = deviceFor(entity, meta);
        await ensureClimate(device, entity);
        meta?.publish?.(snapshot(device));
    },
    convertSet: (entity, key, value, meta) => withActionLock(entity, async () => {
        const device = deviceFor(entity, meta);
        const candidate = confirmedCandidate(device);
        if (!candidate?.control) throw new Error('请先确认保存带完整控制表的空调码库');
        if (key === 'ac_control_status' || key === 'ac_estimate_stale') throw new Error(`${key} is read-only`);
        assertNotSending(entity);
        const climate = climateFor(device);
        const message = Object.fromEntries(climateKeys.filter((name) => Object.hasOwn(meta?.message ?? {}, name))
            .map((name) => [name, meta.message[name]]));
        if (!Object.hasOwn(message, key)) message[key] = value;
        const desired = {...climate.desired};
        const hasMode = Object.hasOwn(message, 'system_mode');
        if (hasMode && !['off', ...candidate.control.modes].includes(message.system_mode)) throw new Error('此码库不支持该工作模式');
        if (Object.hasOwn(message, 'state') && !['ON', 'OFF'].includes(message.state)) throw new Error('state must be ON or OFF');
        if (message.state === 'ON' && message.system_mode === 'off') throw new Error('state ON 与 system_mode off 冲突');
        if (hasMode && message.system_mode !== 'off') desired.mode = message.system_mode;
        desired.power = message.state === 'OFF' || message.system_mode === 'off' ? false :
            message.state === 'ON' || (hasMode && message.system_mode !== 'off') ? true : desired.power;
        const temperatureInput = Object.hasOwn(message, 'occupied_heating_setpoint') ? message.occupied_heating_setpoint : message.ac_temperature_choice;
        if (temperatureInput !== undefined) {
            if (typeof temperatureInput !== 'number' && typeof temperatureInput !== 'string') throw new Error('温度必须是数值');
            const temperature = Number(temperatureInput);
            if (!Number.isFinite(temperature) || String(temperatureInput).trim() === '') throw new Error('温度必须是有限数值');
            const values = temperatureProfile(candidate, desired.mode).values;
            if (!values.includes(temperature)) throw new Error('此码库不支持该温度，请使用其实际温度范围/步长');
            if (message.occupied_heating_setpoint !== undefined && message.ac_temperature_choice !== undefined &&
                Number(message.ac_temperature_choice) !== temperature) throw new Error('两项目标温度值冲突');
            desired.temperature = temperature;
        }
        if (Object.hasOwn(message, 'fan_mode')) desired.fan = message.fan_mode;
        const constraint = modeConstraints(candidate, desired.mode);
        const modeFans = constraint.fans?.length ? constraint.fans : candidate.control.fans;
        if (!Object.hasOwn(message, 'fan_mode') && desired.mode !== climate.desired.mode && !modeFans.includes(desired.fan)) {
            // Selecting a mode must remain reachable when its fan set is disjoint
            // (e.g. auto in cool, only low in dry). Use an actual source mode fan.
            desired.fan = modeFans.includes(candidate.control.defaults.fan) ? candidate.control.defaults.fan : modeFans[0];
        }
        if (constraint.fixedFan !== undefined) {
            if (Object.hasOwn(message, 'fan_mode') && desired.fan !== constraint.fixedFan) throw new Error('当前模式由码库管理风速，不支持此风档');
            desired.fan = constraint.fixedFan;
        }
        if (!candidate.control.fans.includes(desired.fan)) throw new Error('此码库不支持该风速');
        const accepted = lookupControl(candidate, desired);
        const onlyFanOnlyTemperature = constraint.temperatureApplicable === false && desired.power === climate.estimated.power &&
            desired.mode === climate.estimated.mode && desired.fan === climate.estimated.fan &&
            !Object.hasOwn(message, 'state') && !hasMode && !Object.hasOwn(message, 'fan_mode');
        const standbySettingsOnly = !desired.power && !climate.estimated.power && !hasMode && !Object.hasOwn(message, 'state');
        if (standbySettingsOnly || onlyFanOnlyTemperature) {
            const state = await saveState(device, {climate: {...climate, desired,
                status: `${onlyFanOnlyTemperature ? '此模式不控温，已保留下次控温目标' : '已保存待机设置'}；未发送红外。状态为命令估计。`}});
            meta?.deviceExposesChanged?.();
            return {state};
        }
        assertCanSend(entity);
        await saveState(device, {climate: {...climate, pending: true,
            status: `正在发送${desired.power ? controlDescription(desired, candidate) : '关机'}；完成前保留上次命令估计。`}});
        await startTransmission(entity, 'ir_code_to_send', desired.power ? accepted.code : candidate.offCode, meta,
            {purpose: 'climate', candidateId: candidate.id, climateDesired: desired, exposesChanged: meta?.deviceExposesChanged});
        return {state: snapshot(device)};
    }),
};

const learnIrCode = {
    key: ['learn_ir_code'],
    convertSet: async (entity, key, value, meta) => {
        let study;
        if (value === 'ON' || value === true) {
            study = 0;
        } else if (value === 'OFF' || value === false) {
            study = 1;
        } else {
            throw new Error('learn_ir_code must be ON, OFF, true, or false');
        }

        // Zosung 0xE004 / command 0: study=0 starts, study=1 stops learning.
        // The upstream learning converter currently ignores OFF and always starts.
        return withActionLock(entity, () => setLearning(entity, study, meta));
    },
};

const quickMatch = {
    key: ['ac_brand', ...Object.keys(buttons), 'ac_match_status', 'ac_match_candidate', 'ac_saved_codebook'],
    convertGet: async (entity, key, meta) => {
        const device = deviceFor(entity, meta);
        await ensureClimate(device, entity);
        if (stateFor(device).phase === 'sending' && !activeTransfer(entity)) {
            await saveState(device, {phase: 'error', testedCandidateId: null,
                status: '上次传输未确认完成，请检查空调后重试；未确认匹配，已保存码库不变。'});
        }
        const state = snapshot(device);
        // Z2M ignores convertGet return values; explicitly publish virtual state.
        meta?.publish?.(state);
    },
    convertSet: (entity, key, value, meta) => withActionLock(entity, async () => {
        const device = deviceFor(entity, meta);
        if (!device || typeof device.save !== 'function') throw new Error('Quick match requires a paired Zigbee device');
        const state = stateFor(device);
        if (key in buttons && (value === 'OFF' || value === false)) return {state: snapshot(device)};
        if (key === 'ac_match_cancel') {
            if (value !== 'ON' && value !== true) throw new Error(`${key} accepts ON or true only`);
            const transfer = activeTransfer(entity);
            const cancellingMatch = transfer?.purpose === 'match';
            if (cancellingMatch) transfer.cancelled = true;
            return {state: await saveState(device, {candidateId: null, testedCandidateId: null, phase: 'idle',
                status: `已取消匹配；${cancellingMatch ? '已发出的测试不能撤回；' : ''}已保存码库不变。`})};
        }
        assertNotSending(entity);
        if (key === 'ac_brand') {
            const brand = brandsByLabel.get(value);
            if (!brand && value !== NO_BRAND) throw new Error('请选择列表中的空调品牌');
            return {state: await saveState(device, {selectedBrandId: brand?.id ?? null, candidateId: null,
                testedCandidateId: null, phase: 'idle', status: brand ?
                    `已选择${brand.label}，共 ${candidatesFor(brand.id).length} 套；按开始匹配测试。未确认匹配，已保存码库不变。` :
                    '请选择空调品牌；已保存码库不变。'})};
        }
        if (!(key in buttons)) throw new Error(`${key} is read-only`);
        if (value !== 'ON' && value !== true) throw new Error(`${key} accepts ON or true only`);
        if (key === 'ac_match_confirm') {
            const candidate = candidatesById.get(state.candidateId);
            if (candidate && state.confirmedCodebookId === candidate.id && state.phase === 'confirmed') return {state: snapshot(device)};
            if (!candidate || state.testedCandidateId !== candidate.id || state.phase !== 'tested') {
                throw new Error('请先测试当前候选并等待传输完成，再由您确认空调响应是否正确');
            }
            // Old versions retained a tested flag after confirming. Preserve any
            // later OFF/temperature/fan estimate when consuming that legacy flag.
            const repeatedLegacyConfirmation = state.confirmedCodebookId === candidate.id && state.testedTransmissionSeq == null;
            const result = await saveState(device, {confirmedCodebookId: candidate.id, phase: 'confirmed',
                testedCandidateId: null, testedTransmissionSeq: null,
                climate: repeatedLegacyConfirmation ? climateFor(device) : candidate.control ? initialClimate(candidate) : null,
                status: `${describeCandidate(candidate)}；用户已确认并保存 ${candidate.id}。`});
            meta?.deviceExposesChanged?.();
            return {state: result};
        }
        let candidate;
        let purpose = 'match';
        if (key === 'ac_saved_test' || key === 'ac_saved_off') {
            candidate = candidatesById.get(state.confirmedCodebookId);
            if (!candidate) throw new Error('尚无可用的已确认码库，请先完成一次匹配');
            purpose = key === 'ac_saved_off' ? 'saved_off' : 'saved_test';
        } else {
            const list = candidatesFor(state.selectedBrandId);
            if (!list.length) throw new Error('请先选择空调品牌');
            if (key === 'ac_match_start') candidate = list[0];
            else {
                const index = list.findIndex((item) => item.id === state.candidateId);
                if (index < 0) throw new Error('请先按开始匹配');
                if (key === 'ac_match_retry') candidate = list[index];
                else if (key === 'ac_match_next') {
                    if (index + 1 >= list.length) return {state: await saveState(device, {status:
                        `${describeCandidate(list[index])}；已到最后一套，不会循环发码。可重试、确认或取消。`})};
                    candidate = list[index + 1];
                }
            }
        }
        if (!candidate) throw new Error('没有可发送的候选码库');
        assertCanSend(entity);
        // Persist unconfirmed intent before sending; a process restart can never
        // turn an unfinished attempt into a tested or confirmed candidate.
        await saveState(device, {phase: 'sending',
            ...(purpose === 'match' ? {candidateId: candidate.id, testedCandidateId: null, testedTransmissionSeq: null} : {}),
            status: purpose === 'saved_off' ? `${candidate.label.slice(0, 65)}；正在发送已保存码库的关机码，需观察空调。` :
                `${describeCandidate(candidate)}；正在发送${purpose === 'match' ? '测试码，未确认匹配' : '已保存码库测试码，需观察空调'}。`});
        await startTransmission(entity, 'ir_code_to_send', purpose === 'saved_off' ? candidate.offCode : candidate.test.code,
            meta, {purpose, candidateId: candidate.id, exposesChanged: meta?.deviceExposesChanged});
        return {state: snapshot(device)};
    }),
};

function inspectCaptureFrame(transfer, name, msg) {
    const capture = transfer.capture;
    if (name === 'zosung_send_ir_code_00') {
        if (capture.header) return false; // Do not reset a partially received frame.
        if (!Number.isInteger(msg.data.seq) || msg.data.seq < 0 || msg.data.seq > 65535 ||
            !Number.isInteger(msg.data.length) || msg.data.length < 1 || msg.data.length > MAX_CAPTURE_BYTES) {
            throw new Error('按键学习帧头的序号或长度无效');
        }
        capture.header = {seq: msg.data.seq, length: msg.data.length};
        return true;
    }
    if (!capture.header || msg.data.seq !== capture.header.seq) return false;
    if (name === 'zosung_send_ir_code_03') {
        if (msg.data.position !== capture.received) return false;
        const part = msg.data.msgpart;
        if (!Buffer.isBuffer(part) || !part.length || part.length > capture.header.length - capture.received) {
            throw new Error('按键学习分片为空或越过声明长度');
        }
        const crc = [...part].reduce((sum, byte) => sum + byte, 0) & 255;
        if (crc !== msg.data.msgpartcrc) return false;
    }
    if (name === 'zosung_send_ir_code_05') {
        const info = store.getValue(msg.endpoint, 'irMessageInfo');
        if (!capture.finishRequested || capture.received !== capture.header.length || info?.seq !== capture.header.seq ||
            info.data?.position !== capture.header.length || info.data?.buf?.length !== capture.header.length) {
            throw new Error('本次按键学习未完整接收，不能保存');
        }
        validateLearnedStream(info.data.buf);
        capture.completedRaw = Buffer.from(info.data.buf);
    }
    return true;
}

async function processZosungFrame(name, converter, model, msg, publish, options, meta) {
        let transfer = activeTransfer(msg.endpoint);
        const outgoing = ['zosung_send_ir_code_01', 'zosung_send_ir_code_02', 'zosung_send_ir_code_04'].includes(name);
        // Ignore late or overlapping protocol frames; never advance a new job on
        // an old completion, or let a learning packet replace an outgoing buffer.
        if (outgoing && (!transfer || transfer.kind !== 'sending' || msg.data.seq !== transfer.seq)) return;
        if (!outgoing && transfer && transfer.kind !== 'learning') return;
        if (!outgoing && name !== 'zosung_send_ir_code_00' && !transfer) return;
        if (name === 'zosung_send_ir_code_00' && !transfer) {
            transfer = {kind: 'learning', device: msg.device ?? meta?.device};
            store.putValue(msg.endpoint, TRANSFER_KEY, transfer);
            armTimeout(msg.endpoint, transfer, LEARN_TIMEOUT_MS);
        }
        try {
            let acknowledgedEnd;
            if (outgoing) {
                const message = store.getValue(msg.endpoint, 'irMessageInfo');
                if (message?.seq !== transfer.seq || typeof message.data !== 'string') return;
                if (name === 'zosung_send_ir_code_02') {
                    const position = msg.data.position;
                    // Retransmit an acknowledged chunk without advancing progress.
                    // Ignore gaps, negative offsets and past-end requests entirely.
                    if (!Number.isInteger(position) || position < 0 || position >= message.data.length ||
                        (position !== transfer.acknowledgedBytes && !transfer.acknowledgedChunks?.has(position))) return;
                    acknowledgedEnd = Math.min(position + 50, message.data.length);
                }
                if (name === 'zosung_send_ir_code_04' &&
                    (transfer.acknowledgedBytes !== message.data.length || !transfer.acknowledgedBytes)) return;
            }
            if (transfer.capture && !inspectCaptureFrame(transfer, name, msg)) return;
            const result = await converter.convert(model, msg, publish, options, meta);
            // A timeout may have invalidated this operation while its final radio
            // acknowledgement was pending. Never commit or finish a newer job.
            if (activeTransfer(msg.endpoint) !== transfer || transfer.kind === 'finishing') return;
            if (acknowledgedEnd !== undefined) {
                transfer.acknowledgedChunks.set(msg.data.position, acknowledgedEnd);
                transfer.acknowledgedBytes = Math.max(transfer.acknowledgedBytes, acknowledgedEnd);
            }
            if (transfer.capture) {
                if (activeTransfer(msg.endpoint) !== transfer || !currentCapture(transfer)) return;
                const capture = transfer.capture;
                if (name === 'zosung_send_ir_code_03') {
                    capture.received += msg.data.msgpart.length;
                    capture.finishRequested = capture.received === capture.header.length;
                }
                if (name === 'zosung_send_ir_code_05') {
                    if (bankFor(transfer.device).learning?.id !== capture.id ||
                        result?.learned_ir_code !== capture.completedRaw.toString('base64')) return;
                    const capturedAt = Date.now();
                    await markClimateStale(transfer.device, '已接收到其他遥控器红外指令；空调面板估计可能已过期，请观察实际状态。');
                    const status = await saveBank(transfer.device, {learning: null, rawLearning: false, stopRequired: false,
                        pending: {captureId: capture.id,
                        capturedAt, startedAt: capture.startedAt, validated: true, code: result.learned_ir_code},
                        status: `收到完整新码（${new Date(capturedAt).toISOString()}，${capture.completedRaw.length} 字节）；请确认按键来源及名称，10 分钟内保存/更新。尚未入库。`});
                    clearTransfer(msg.endpoint, transfer);
                    return {...result, ...status};
                }
            }
            if (name === 'zosung_send_ir_code_04' && transfer) {
                transfer.kind = 'finishing';
                let status;
                if (transfer.purpose && !transfer.cancelled) {
                    const candidate = candidatesById.get(transfer.candidateId);
                    if (transfer.purpose === 'named_key') {
                        const climate = climateFor(transfer.device);
                        status = await saveState(transfer.device, {keyBank: {...bankFor(transfer.device),
                            status: `“${transfer.keyName}”传输完成；未取得家电实际反馈。`},
                            ...(climate ? {climate: {...climate, estimateStale: true,
                                status: '已发送命名红外按键；空调面板估计可能已过期，请观察实际状态。'}} : {})});
                    } else if (transfer.purpose === 'climate') {
                        const desired = transfer.climateDesired;
                        status = await saveState(transfer.device, {climate: {codebookId: candidate.id, desired, estimated: {...desired}, estimateStale: false,
                            status: `${desired.power ? controlDescription(desired, candidate) : '关机'}；设备传输完成，仅为命令估计，请观察空调。`}});
                        transfer.exposesChanged?.();
                    } else {
                        const climate = climateFor(transfer.device);
                        const extra = climate && climate.codebookId === candidate.id && transfer.purpose !== 'match' ? {
                            climate: transfer.purpose === 'saved_off' ? {...climate, estimateStale: false,
                                desired: {...climate.desired, power: false}, estimated: {...climate.estimated, power: false},
                                status: '已保存关机码传输完成；仅为命令估计，请观察空调。'} : initialClimate(candidate),
                        } : {};
                        status = await saveState(transfer.device, transfer.purpose === 'match' ? {
                        testedCandidateId: candidate.id, testedTransmissionSeq: transfer.seq, phase: 'tested',
                        status: `${describeCandidate(candidate)}；设备已完成传输，未确认匹配。响应正确请按确认匹配成功。`,
                        } : {phase: 'idle', ...extra, status: `${candidate.label.slice(0, 65)}；已保存码库${transfer.purpose === 'saved_off' ? '关机' : testAction(candidate)}传输完成；请观察空调实际响应。`});
                        if (Object.keys(extra).length) transfer.exposesChanged?.();
                    }
                } else if (!transfer.purpose) {
                    await markClimateStale(transfer.device, '已发送原始红外指令；空调面板估计可能已过期，请观察实际状态。');
                    status = snapshot(transfer.device);
                }
                clearTransfer(msg.endpoint, transfer);
                return {...result, ...status};
            }
            if (name === 'zosung_send_ir_code_05' && transfer) {
                if (typeof transfer.device?.save === 'function') {
                    await markClimateStale(transfer.device, '已接收到其他遥控器红外指令；空调面板估计可能已过期，请观察实际状态。');
                    const state = await saveBank(transfer.device, {rawLearning: false, stopRequired: false,
                        status: '原始学习已完成；未保存命名按键，创建按键请使用开始按键学习。'});
                    clearTransfer(msg.endpoint, transfer);
                    return {...result, ...state};
                }
                clearTransfer(msg.endpoint, transfer);
            }
            return result;
        } catch (error) {
            if (transfer) await failTransfer(msg.endpoint, transfer, `传输失败：${String(error.message).slice(0, 90)}`);
            throw error;
        }
}

const fromZosung = Object.entries(fzZosung).map(([name, converter]) => ({
    ...converter,
    convert: (model, msg, publish, options, meta) => {
        const transfer = activeTransfer(msg.endpoint);
        if (transfer?.kind === 'sending') {
            // Serialize outbound chunk ACKs and completion, including a 04 that
            // arrives while the last 03 acknowledgement is still pending.
            transfer.sendChain ??= Promise.resolve();
            transfer.acknowledgedChunks ??= new Map();
            const job = transfer.sendChain.then(() => {
                if (activeTransfer(msg.endpoint) !== transfer || transfer.kind !== 'sending') return;
                return processZosungFrame(name, converter, model, msg, publish, options, meta);
            });
            transfer.sendChain = job.catch(() => {});
            return job;
        }
        if (!transfer?.capture) return processZosungFrame(name, converter, model, msg, publish, options, meta);
        if (!currentCapture(transfer)) {
            clearTransfer(msg.endpoint, transfer);
            return saveBank(transfer.device, {learning: null, rawLearning: false, stopRequired: true, pending: null,
                status: '模块已重载，上次未完成学习已作废；请先停止学习，没有导入旧码，也不会自动学习或发送。'});
        }
        // Serialize named-learning packets, including a final 05 arriving while
        // the last 03 is still awaiting its outgoing 04 acknowledgement.
        const job = transfer.receiveChain.then(async () => {
            if (!(await transfer.capture.startReady) || activeTransfer(msg.endpoint) !== transfer || !currentCapture(transfer)) return;
            return processZosungFrame(name, converter, model, msg, publish, options, meta);
        });
        transfer.receiveChain = job.catch(() => {});
        return job;
    },
}));

function exposeClimate(device, options) {
    const candidate = confirmedCandidate(device);
    const id = device?.ieeeAddr ?? options?.ID;
    if (!candidate?.control || !id) {
        if (id) discoveryControls.delete(id);
        return [];
    }
    const control = candidate.control;
    const climate = climateFor(device);
    const constraints = modeConstraints(candidate, climate.desired.mode);
    const fanModes = constraints.fans?.length ? constraints.fans : control.fans;
    const temperatureRange = temperatureProfile(candidate, climate.desired.mode);
    const discreteTemperature = temperatureRange.step === null;
    discoveryControls.set(id, {control, fanModes, discreteTemperature, temperatureRange});
    const temperature = e.numeric('occupied_heating_setpoint', discreteTemperature ? ea.STATE_GET : ea.ALL)
        .withLabel('目标温度').withUnit('°C').withValueMin(temperatureRange.min).withValueMax(temperatureRange.max)
        .withDescription(constraints.temperatureApplicable === false ? '当前模式不控温；保留的温度用于下次制冷/制热' :
            discreteTemperature ? '此码库温度不等距，请用温度选择下拉框调整' : '设定目标温度；显示命令估计值，红外设备不提供室温')
        // Native Z2M climate discovery requires a local_temperature expose. Use
        // its supported type override + payload hook without inventing a sensor.
        .withHomeAssistant({type: 'climate'});
    if (!discreteTemperature) temperature.withValueStep(temperatureRange.step);
    return [
        e.binary('state', ea.ALL, 'ON', 'OFF').withLabel('空调电源')
            .withDescription('ON 恢复保存的模式/温度/风速，OFF 发送关机；状态为命令估计'),
        e.enum('system_mode', ea.ALL, ['off', ...control.modes]).withLabel('工作模式')
            .withDescription('选择非 off 模式会开机；送风不控温，除湿风速按码库规则管理'),
        temperature,
        ...(discreteTemperature ? [e.enum('ac_temperature_choice', ea.ALL, temperatureRange.values.map(String))
            .withLabel('温度选择').withDescription('仅列出此码库实际支持的离散温度；不会自动取邻近值')] : []),
        e.enum('fan_mode', ea.ALL, fanModes).withLabel('风速')
            .withDescription(constraints.fanControllable === false ? '当前模式自动管理风速' : '设置此码库实际支持的风档；状态为命令估计'),
    ];
}

function overrideClimateDiscovery(payload, options) {
    if (typeof payload.object_id !== 'string' || !payload.object_id.endsWith('_occupied_heating_setpoint')) return;
    const topic = payload.state_topic;
    const capabilities = discoveryControls.get(options?.ID);
    for (const key of ['min', 'max', 'step', 'mode', 'unit_of_measurement', 'command_topic', 'state_topic', 'value_template',
        'device_class', 'state_class', 'options', 'current_temperature_topic', 'current_temperature_template']) delete payload[key];
    if (!capabilities || typeof topic !== 'string') {
        // getConfigs() normally calls exposes(device, options) immediately before
        // this hook. If that contract is broken, advertise no actionable controls.
        payload.enabled_by_default = false;
        return;
    }
    const {control, fanModes, discreteTemperature, temperatureRange} = capabilities;
    Object.assign(payload, {
        name: '空调',
        temperature_unit: 'C',
        min_temp: temperatureRange.min,
        max_temp: temperatureRange.max,
        modes: ['off', ...control.modes],
        mode_command_topic: `${topic}/set/system_mode`,
        mode_state_topic: topic,
        mode_state_template: '{{ value_json.system_mode }}',
        fan_modes: fanModes,
        fan_mode_command_topic: `${topic}/set/fan_mode`,
        fan_mode_state_topic: topic,
        fan_mode_state_template: '{{ value_json.fan_mode }}',
        temperature_state_topic: topic,
        temperature_state_template: '{{ value_json.occupied_heating_setpoint }}',
        json_attributes_topic: topic,
        json_attributes_template: "{{ {'ac_control_status': value_json.get('ac_control_status', ''), 'ac_saved_codebook': value_json.get('ac_saved_codebook', ''), 'ac_estimate_stale': value_json.get('ac_estimate_stale', false)} | tojson if value_json is mapping else '{}' }}",
    });
    if (!discreteTemperature) {
        payload.temp_step = temperatureRange.step;
        payload.temperature_command_topic = `${topic}/set/occupied_heating_setpoint`;
    }
}

function exposeKeyBank(device) {
    const bank = bankFor(device);
    if (device?.ieeeAddr) keyDiscoveryRevisions.set(device.ieeeAddr, bank.revision);
    return [
        ...bank.entries.map((entry) => e.enum(`ir_key_${entry.id}`, ea.SET, ['发送']).withLabel(entry.name)
            .withDescription(`点击发送此已保存按键一次：${entry.name}；不会推导家电真实状态`)),
        ...(bank.entries.length ? [e.enum('ir_key_selected', ea.ALL, [NO_KEY, ...bank.entries.map((entry) => entry.name)])
            .withLabel('已保存按键').withDescription('选择只更新选择，不会发送红外')] : []),
        e.text('ir_key_name', ea.ALL).withLabel('按键名称').withCategory('config')
            .withDescription('输入 1–48 字符名称；开始按键学习后需确认来源并保存'),
        ...Object.entries(keyActions).filter(([key]) => relevantKeyActions(bank).includes(key)).map(([key, [label, description]]) => {
            const expose = e.binary(key, ea.SET, 'ON', 'OFF').withLabel(label)
                .withDescription(`${description}；ON 执行，OFF 不执行`).withHomeAssistant({type: 'button'});
            return key === 'ir_key_send' ? expose : expose.withCategory('config');
        }),
        e.text('ir_key_status', ea.STATE_GET).withLabel('按键库状态').withCategory('diagnostic')
            .withDescription('新捕获时间、有效性和最近操作；状态不包含整份编码库'),
        e.numeric('ir_key_count', ea.STATE_GET).withLabel('已保存按键数量').withCategory('diagnostic')
            .withValueMin(0).withValueMax(MAX_KEYS),
    ];
}

// Hot reload does not call Z2M's start hook again. Transfer completed-pending
// expiry to this module while preserving the capturedAt deadline and callbacks.
for (const {device} of sharedKeyMap('contexts').values()) scheduleKeyExpiry(device);

export default {
    fingerprint: [{modelID: 'TS1201', manufacturerName: '_TZ3290_qazgdsae'}],
    model: 'TS1201',
    vendor: 'Zemismart',
    description: 'Zigbee universal infrared remote control',
    meta: {
        overrideHaDiscoveryPayload: (payload, options) => {
            overrideClimateDiscovery(payload, options);
            const commandKey = typeof payload.command_topic === 'string' ? payload.command_topic.split('/set/').at(-1) : '';
            if (isNamedKey(commandKey) || commandKey === 'ir_key_selected' || Object.hasOwn(keyActions, commandKey)) {
                // Z2M 2.14.1 retains its discovery cache after deleting a topic.
                // A stable-ID undo needs a new payload revision to republish it.
                // MQTT Button's standard template emits the original press value.
                payload.command_template = `{# key bank revision ${keyDiscoveryRevisions.get(options?.ID) ?? 0} #}{{ value }}`;
            }
            if (typeof payload.command_topic === 'string' && [...buttonKeys].some((key) => payload.command_topic.endsWith(`/set/${key}`))) {
                // Z2M's binary -> button metadata override leaves switch payloads.
                // HA buttons otherwise send their default PRESS, not value_on.
                payload.payload_press = 'ON';
                delete payload.payload_on;
                delete payload.payload_off;
                delete payload.value_template;
                delete payload.state_topic;
            }
            if (typeof payload.object_id === 'string' && payload.object_id.endsWith('_learned_ir_code') &&
                typeof payload.state_topic === 'string') {
                // HA sensor states are limited in length. Keep Z2M's short state,
                // and preserve the full reusable code in one JSON attribute.
                payload.json_attributes_topic = payload.state_topic;
                payload.json_attributes_template =
                    "{{ {'learned_ir_code': value_json['learned_ir_code']} | tojson " +
                    "if value_json is mapping and 'learned_ir_code' in value_json else '{}' }}";
            }
        },
    },
    extend: [zosungExtend.addZosungIRTransmitCluster(), zosungExtend.addZosungIRControlCluster()],
    onEvent: (event) => {
        if (event.type === 'stop') {
            const id = event.data.ieeeAddr;
            const timers = sharedKeyMap('expiryTimers');
            clearTimeout(timers.get(id));
            timers.delete(id);
            sharedKeyMap('contexts').delete(id);
            return;
        }
        const device = event.data.device;
        if (device?.modelID !== 'TS1201' || device.manufacturerName !== '_TZ3290_qazgdsae') return;
        rememberKeyContext(undefined, event.data);
        scheduleKeyExpiry(device);
    },
    fromZigbee: fromZosung,
    toZigbee: [climateControl, sendIrCode, learnIrCode, quickMatch, keyBankControl, namedKeyControl],
    exposes: (device, options) => [
        e.enum('ac_brand', ea.ALL, [NO_BRAND, ...brandsByLabel.keys()]).withLabel('空调品牌')
            .withDescription('选择品牌只更新选择，不发送红外；再点击开始匹配的 ON'),
        e.text('ac_match_status', ea.STATE_GET).withLabel('匹配状态').withDescription('候选名称、进度、实际测试动作和用户确认状态'),
        ...exposeClimate(device, options),
        e.text('ac_control_status', ea.STATE_GET).withLabel('空调控制状态')
            .withDescription('说明可用操作及最近指令结果；红外单向控制，界面状态不代表空调实际反馈'),
        e.binary('ac_estimate_stale', ea.STATE_GET, true, false).withLabel('空调估计可能已过期').withCategory('diagnostic')
            .withDescription('其他红外指令或未确认的控制可能改变空调；完成一条已匹配空调指令后恢复命令估计'),
        ...exposeKeyBank(device),
        ...Object.entries(buttons).map(([key, [label, description]]) =>
            e.binary(key, ea.SET, 'ON', 'OFF').withLabel(label)
                .withDescription(`${description}；点击 ON 执行，OFF 不执行`)
                .withHomeAssistant({type: 'button'})),
        e.text('ac_match_candidate', ea.STATE_GET).withLabel('当前候选码库').withDescription('正在尝试的码库 ID，不代表已匹配成功'),
        e.text('ac_saved_codebook', ea.STATE_GET).withLabel('已保存码库').withDescription('仅由确认匹配成功按钮保存，保存在设备元数据中'),
        presetsZosung.learn_ir_code().withLabel('原始红外学习（不保存为命名按键）')
            .withDescription('ON 开始原始学习，OFF 停止；保存命名按键请使用开始按键学习入口'),
        presetsZosung.learned_ir_code(),
        presetsZosung.learned_ir_timings(),
        presetsZosung.ir_code_to_send(),
        presetsZosung.ir_emitter(),
    ],
};
