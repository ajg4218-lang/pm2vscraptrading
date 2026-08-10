/**
 * PM2V Scrap Trading - Shared Utilities
 * Sanitization, Toast Notifications, Confirmation Dialogs, Form Validation
 */

// ============================================================
// XSS SANITIZATION
// ============================================================

/**
 * Escapes HTML special characters to prevent XSS injection.
 * Use this whenever rendering user-supplied data into HTML strings.
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================================
// TOAST NOTIFICATION SYSTEM
// ============================================================

let toastContainer = null;

function ensureToastContainer() {
    if (toastContainer && document.body.contains(toastContainer)) return;
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = `
        position: fixed; top: 24px; right: 24px; z-index: 99999;
        display: flex; flex-direction: column; gap: 10px;
        pointer-events: none; max-width: 380px;
    `;
    document.body.appendChild(toastContainer);
}

/**
 * Show a toast notification.
 * @param {string} message - The message to display
 * @param {'success'|'error'|'warning'|'info'} type - Toast type
 * @param {number} duration - Duration in ms (default 3500)
 */
export function showToast(message, type = 'info', duration = 3500) {
    ensureToastContainer();

    const colors = {
        success: { bg: '#dcfce7', border: '#16a34a', text: '#166534', icon: '&#10003;' },
        error:   { bg: '#fee2e2', border: '#dc2626', text: '#991b1b', icon: '&#10007;' },
        warning: { bg: '#fef3c7', border: '#d97706', text: '#92400e', icon: '&#9888;' },
        info:    { bg: '#eff6ff', border: '#2563eb', text: '#1e40af', icon: '&#8505;' }
    };
    const c = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.style.cssText = `
        display: flex; align-items: center; gap: 12px;
        padding: 14px 20px; border-radius: 12px;
        background: ${c.bg}; border: 1px solid ${c.border};
        color: ${c.text}; font-size: 14px; font-weight: 500;
        font-family: 'Poppins', sans-serif;
        box-shadow: 0 10px 25px rgba(0,0,0,0.1);
        pointer-events: auto; cursor: pointer;
        transform: translateX(120%); transition: transform 0.3s ease, opacity 0.3s ease;
        opacity: 0;
    `;
    toast.innerHTML = `<span style="font-size:18px;flex-shrink:0;">${c.icon}</span><span>${escapeHtml(message)}</span>`;
    toast.addEventListener('click', () => dismissToast(toast));

    toastContainer.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
        toast.style.opacity = '1';
    });

    // Auto dismiss
    setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast) {
    toast.style.transform = 'translateX(120%)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
}

// ============================================================
// CONFIRMATION DIALOG
// ============================================================

/**
 * Shows a confirmation dialog. Returns a Promise<boolean>.
 * @param {string} title - Dialog title
 * @param {string} message - Dialog message
 * @param {string} confirmText - Confirm button label (default "Confirm")
 * @param {'danger'|'primary'} confirmType - Button style
 */
export function showConfirm(title, message, confirmText = 'Confirm', confirmType = 'danger') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 99998;
            background: rgba(0,0,0,0.5); backdrop-filter: blur(3px);
            display: flex; align-items: center; justify-content: center;
            animation: fadeIn 0.2s ease;
        `;

        const btnBg = confirmType === 'danger' ? '#dc2626' : '#166734';

        overlay.innerHTML = `
            <div style="background:white; border-radius:16px; padding:28px; max-width:400px; width:90%; box-shadow:0 25px 50px rgba(0,0,0,0.15);">
                <h3 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1a202c;">${escapeHtml(title)}</h3>
                <p style="margin:0 0 24px; font-size:14px; color:#64748b; line-height:1.5;">${escapeHtml(message)}</p>
                <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button id="confirm-cancel" style="padding:10px 20px; border:1.5px solid #e2e8f0; background:white; color:#334155; border-radius:10px; font-weight:600; font-size:14px; cursor:pointer; font-family:inherit;">Cancel</button>
                    <button id="confirm-ok" style="padding:10px 20px; border:none; background:${btnBg}; color:white; border-radius:10px; font-weight:700; font-size:14px; cursor:pointer; font-family:inherit;">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('#confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
        overlay.querySelector('#confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
}

// ============================================================
// FORM VALIDATION HELPERS
// ============================================================

/**
 * Validates a form field and shows/hides an inline error.
 * @param {HTMLElement} input - The input element
 * @param {string} errorMessage - Error message to display (empty = valid)
 */
export function setFieldError(input, errorMessage) {
    const group = input.closest('.form-group') || input.parentElement;
    let errorEl = group.querySelector('.field-error');

    if (errorMessage) {
        input.style.borderColor = '#dc2626';
        input.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.08)';
        if (!errorEl) {
            errorEl = document.createElement('span');
            errorEl.className = 'field-error';
            errorEl.style.cssText = 'display:block; font-size:12px; color:#dc2626; margin-top:4px; font-weight:500;';
            group.appendChild(errorEl);
        }
        errorEl.textContent = errorMessage;
    } else {
        input.style.borderColor = '';
        input.style.boxShadow = '';
        if (errorEl) errorEl.remove();
    }
}

/**
 * Clears all field errors within a container.
 */
export function clearFieldErrors(container) {
    container.querySelectorAll('.field-error').forEach(el => el.remove());
    container.querySelectorAll('input, select').forEach(el => {
        el.style.borderColor = '';
        el.style.boxShadow = '';
    });
}

/**
 * Validates that a field is not empty. Returns true if valid.
 */
export function validateRequired(input, label) {
    const val = input.value.trim();
    if (!val) {
        setFieldError(input, `${label} is required`);
        return false;
    }
    setFieldError(input, '');
    return true;
}

/**
 * Validates a numeric field with min value. Returns true if valid.
 */
export function validateNumber(input, label, min = 0) {
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= min) {
        setFieldError(input, `${label} must be greater than ${min}`);
        return false;
    }
    setFieldError(input, '');
    return true;
}
