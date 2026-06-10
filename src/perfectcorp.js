// Perfect Corp — AI Necklace Virtual Try-On client (S2S AI API), running straight from the
// browser for this demo. Flow per the official docs (docs.perfectcorp.com/reference/ai_necklace):
//
//   1. Auth      POST  /s2s/v1.0/client/auth      { client_id, id_token } -> { access_token }
//                  id_token = base64( RSA/PKCS1 encrypt( "client_id=…&timestamp=…", secretKey ) )
//   2. Upload    POST  /s2s/v2.0/file/2d-vto/necklace   -> presigned { url, headers, method } + file_id
//                  then PUT the image bytes to that url
//   3. Run       POST  /s2s/v2.0/task/2d-vto/necklace   { src_file_id, ref_file_ids, … } -> task_id
//   4. Poll      GET   /s2s/v2.0/task/2d-vto/necklace/{task_id}  until success/error -> result url
//
// Everything is parsed defensively (result/data/top-level envelopes) so small response-shape
// differences between API versions don't break the demo.
import JSEncrypt from 'jsencrypt';

// Wrap a bare base64 DER public key into the PEM envelope JSEncrypt expects.
function derToPem(der) {
    const body = der
        .replace(/\s+/g, '')
        .replace(/(.{64})/g, '$1\n')
        .trim();
    return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map Perfect Corp error codes to short, user-facing Vietnamese hints.
const ERROR_VI = {
    PHOTO_DETECTION_FAIL: 'Không nhận được cổ trong ảnh. Hãy ngồi thẳng, để lộ cổ và vai rồi thử lại.',
    PHOTO_CHECK_INVALID: 'Tư thế chưa hợp lệ. Giữ mặt thẳng (xoay dưới 20°) và để cổ chiếm đủ khung hình.',
    OBJECT_DETECTION_FAIL: 'Không nhận diện được dây chuyền trong ảnh sản phẩm.',
    INPUT_ERROR: 'Định dạng ảnh không hợp lệ. Hãy thử lại.',
    INPUT_MAIN_IMAGE_EMPTY: 'Thiếu ảnh selfie. Hãy chụp lại.',
    RUNTIME_ERROR: 'Máy chủ AI gặp lỗi khi xử lý. Vui lòng thử lại.',
    InvalidParameters: 'Tham số gửi lên không hợp lệ.',
    CreditInsufficiency: 'Tài khoản Perfect Corp đã hết credits.',
    BadRequest: 'Yêu cầu không hợp lệ.'
};

function describeError(json, httpStatus, fallback) {
    const code = json && (json.error_code || json.code);
    if (code && ERROR_VI[code]) return ERROR_VI[code];
    if (httpStatus === 401) return 'Khóa API không hợp lệ hoặc đã hết hạn (401).';
    if (httpStatus === 429) return 'Gọi quá nhiều lần, thử lại sau giây lát (429).';
    const msg = json && (json.error || json.message);
    return msg || fallback;
}

async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

/**
 * Build a Perfect Corp necklace try-on client.
 * @param {object} cfg PERFECTCORP config block from config.js
 */
export function createPerfectCorpClient(cfg) {
    const base = cfg.apiBase.replace(/\/+$/, '');
    const encryptor = new JSEncrypt();
    encryptor.setPublicKey(derToPem(cfg.secretKey));

    let s2sCache = null; // { token, expireAt }

    // Secure S2S flow: RSA-sign client_id+timestamp with the public key -> id_token, exchange it
    // at the auth endpoint for a short-lived access_token.
    async function getS2sToken() {
        if (s2sCache && s2sCache.expireAt > Date.now() + 5000) return s2sCache.token;

        const idToken = encryptor.encrypt(`client_id=${cfg.apiKey}&timestamp=${Date.now()}`);
        if (!idToken) {
            throw new Error('Không tạo được id_token (RSA encrypt thất bại — kiểm tra secretKey).');
        }

        const res = await fetch(base + cfg.authPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: cfg.apiKey, id_token: idToken })
        });
        const json = await readJson(res);
        if (!res.ok) throw new Error(describeError(json, res.status, 'Xác thực Perfect Corp thất bại.'));

        const result = json.result || json.data || json;
        const token = result.access_token || result.accessToken;
        if (!token) throw new Error('Phản hồi xác thực không có access_token.');

        // Honour expires_in (seconds) or expires_at (epoch s/ms); default to 9 minutes.
        let ttl = 9 * 60 * 1000;
        if (result.expires_in) ttl = Number(result.expires_in) * 1000;
        else if (result.expires_at) {
            const at = Number(result.expires_at);
            ttl = (at > 1e12 ? at : at * 1000) - Date.now();
        }
        s2sCache = { token, expireAt: Date.now() + Math.max(30000, ttl) };
        return token;
    }

    // Auth mode: 'apikey' sends the sk- key directly as the Bearer token (as the necklace endpoint
    // doc shows); 's2s' exchanges it for a short-lived access_token. 'auto' (default) tries the
    // direct key first and falls back to S2S once if the server answers 401.
    const wanted = cfg.authMode || 'auto';
    let mode = wanted === 's2s' ? 's2s' : 'apikey';

    async function bearer() {
        return mode === 's2s' ? await getS2sToken() : cfg.apiKey;
    }

    // Fetch with the current Authorization header; on a 401 in 'auto' mode, flip the auth method
    // once and retry. Only JSON/no-body API calls go through here (never the presigned blob PUT).
    async function authedFetch(url, opts = {}, retried = false) {
        const headers = { ...(opts.headers || {}), Authorization: `Bearer ${await bearer()}` };
        const res = await fetch(url, { ...opts, headers });
        if (res.status === 401 && wanted === 'auto' && !retried) {
            mode = mode === 'apikey' ? 's2s' : 'apikey';
            s2sCache = null;
            return authedFetch(url, opts, true);
        }
        return res;
    }

    // Upload one image and return its file_id (used as src/ref in the task payload).
    async function uploadFile(blob, fileName) {
        const contentType = blob.type || 'image/jpeg';
        const res = await authedFetch(base + cfg.filePath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: [{ content_type: contentType, file_name: fileName, file_size: blob.size }]
            })
        });
        const json = await readJson(res);
        if (!res.ok) throw new Error(describeError(json, res.status, 'Xin URL tải ảnh thất bại.'));

        const files = (json.result && json.result.files) || json.files || (json.data && json.data.files);
        const fileObj = files && files[0];
        const upload = fileObj && fileObj.requests && fileObj.requests[0];
        if (!fileObj || !upload || !upload.url) {
            throw new Error('Phản hồi File API thiếu URL tải lên.');
        }

        const put = await fetch(upload.url, {
            method: upload.method || 'PUT',
            headers: upload.headers || { 'Content-Type': contentType },
            body: blob
        });
        if (!put.ok) throw new Error(`Tải ảnh lên thất bại (${put.status}).`);

        return fileObj.file_id;
    }

    // Create the necklace VTO task; returns the task_id.
    async function createTask(srcFileId, refFileId) {
        const parameter = {
            necklace_need_remove_background: cfg.removeBackground !== false,
            necklace_shadow_intensity: cfg.shadowIntensity,
            necklace_ambient_light_intensity: cfg.ambientLight
        };
        const body = {
            src_file_id: srcFileId,
            ref_file_ids: [refFileId],
            source_info: { name: srcFileId },
            object_infos: [{ name: refFileId, parameter }]
        };

        const res = await authedFetch(base + cfg.taskPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const json = await readJson(res);
        if (!res.ok) throw new Error(describeError(json, res.status, 'Tạo tác vụ thử dây chuyền thất bại.'));

        const data = json.data || json.result || json;
        const taskId = data.task_id || data.taskId;
        if (!taskId) throw new Error('Không nhận được task_id từ máy chủ.');
        return taskId;
    }

    // Pull the task status/result out of whatever envelope the API returns.
    function parsePoll(json) {
        const r = (json && (json.result || json.data)) || json || {};
        const rawStatus =
            r.task_status ||
            (typeof r.status === 'string' ? r.status : undefined) ||
            (typeof json.status === 'string' ? json.status : undefined);
        const status = rawStatus ? String(rawStatus).toLowerCase() : '';
        const url =
            r.url ||
            (r.result && r.result.url) ||
            (Array.isArray(r.results) && r.results[0] && (r.results[0].url ||
                (Array.isArray(r.results[0].data) && r.results[0].data[0] && r.results[0].data[0].url))) ||
            (Array.isArray(r.data) && r.data[0] && r.data[0].url) ||
            undefined;
        return { status, url };
    }

    async function pollTask(taskId) {
        const url = `${base}${cfg.taskPath}/${encodeURIComponent(taskId)}`;
        const deadline = Date.now() + cfg.pollTimeoutMs;
        const DONE = ['success', 'succeeded', 'completed', 'done', 'finished'];
        const FAILED = ['error', 'failed', 'fail'];

        while (Date.now() < deadline) {
            const res = await authedFetch(url, {});
            const json = await readJson(res);
            if (res.ok) {
                const { status, url: resultUrl } = parsePoll(json);
                if (FAILED.includes(status)) {
                    throw new Error(describeError(json.result || json.data || json, 200, 'Xử lý ảnh thất bại.'));
                }
                if (resultUrl && (status === '' || DONE.includes(status))) return resultUrl;
            } else if (res.status === 401) {
                s2sCache = null; // token expired mid-poll — refresh on next loop
            } else if (res.status !== 404 && res.status !== 202) {
                throw new Error(describeError(json, res.status, `Lỗi kiểm tra tiến trình (${res.status}).`));
            }
            await sleep(cfg.pollIntervalMs);
        }
        throw new Error('Quá thời gian chờ xử lý. Mạng có thể chậm — hãy thử lại.');
    }

    /**
     * Run a full necklace try-on: upload selfie + product, fire the task, poll, return result URL.
     * @param {Blob} selfieBlob captured webcam frame (jpeg)
     * @param {Blob} refBlob necklace product image
     * @param {{selfieName?: string, refName?: string}} [opts]
     * @returns {Promise<string>} URL of the photoreal result image (valid ~2h)
     */
    async function tryOnNecklace(selfieBlob, refBlob, opts = {}) {
        const [srcId, refId] = await Promise.all([
            uploadFile(selfieBlob, opts.selfieName || 'selfie.jpg'),
            uploadFile(refBlob, opts.refName || 'necklace.png')
        ]);
        const taskId = await createTask(srcId, refId);
        return pollTask(taskId);
    }

    return { tryOnNecklace };
}
