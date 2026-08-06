import {parseEnvelope, queryToString} from '../deepseek.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertRejectsTokenInvalid(fn, message) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof Error && thrown.name === 'TokenInvalidError'))
        throw new Error(`${message}: expected TokenInvalidError, got ${thrown?.name ?? 'no error'}`);
}

// ---- parseEnvelope: 正常解包 ----
const summaryBody = JSON.stringify({code: 0, data: {biz_code: 0, biz_data: {
    normal_wallets: [{currency: 'CNY', balance: '10.5'}],
    total_costs: [{currency: 'CNY', amount: '1.2'}],
}}});
const parsed = parseEnvelope(summaryBody, 200);
assertEqual(parsed.normal_wallets[0].balance, '10.5', 'unwraps biz_data');
assertEqual(parsed.total_costs[0].amount, '1.2', 'keeps nested fields');

// ---- parseEnvelope: token 失效（HTTP 401）----
assertRejectsTokenInvalid(
    () => parseEnvelope('{"error":"unauthorized"}', 401),
    '401 -> TokenInvalidError');

// ---- parseEnvelope: biz_code=1 且含 TOKEN 字样 ----
assertRejectsTokenInvalid(
    () => parseEnvelope(JSON.stringify({code: 0, data: {biz_code: 1, biz_msg: 'INVALID_TOKEN'}}), 200),
    'biz INVALID_TOKEN -> TokenInvalidError');

// ---- parseEnvelope: 其他业务错误 ----
let bizErr = null;
try {
    parseEnvelope(JSON.stringify({code: 0, data: {biz_code: 1, biz_msg: 'INVALID_PARAM'}}), 200);
} catch (error) {
    bizErr = error;
}
assertEqual(bizErr instanceof Error && bizErr.name !== 'TokenInvalidError', true, 'other biz error -> plain Error');

// ---- parseEnvelope: 非 200 ----
let httpErr = null;
try {
    parseEnvelope('blocked', 429);
} catch (error) {
    httpErr = error;
}
assertEqual(httpErr instanceof Error, true, '429 -> plain Error');

// ---- parseEnvelope: 无效 JSON ----
let jsonErr = null;
try {
    parseEnvelope('not json', 200);
} catch (error) {
    jsonErr = error;
}
assertEqual(jsonErr instanceof Error, true, 'bad JSON -> Error');

// ---- queryToString ----
assertEqual(queryToString({}), '', 'empty query -> empty');
assertEqual(queryToString({a: 1, b: 'x y'}), '?a=1&b=x%20y', 'encodes query');

print('deepseek net tests: ok');
