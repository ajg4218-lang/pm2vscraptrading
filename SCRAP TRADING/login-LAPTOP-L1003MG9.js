import { auth, db } from './firebase.js';
import { 
    signInWithEmailAndPassword, 
    signOut, 
    setPersistence, 
    browserLocalPersistence,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc,
    addDoc,
    collection,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


const loginForm = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');
const applyModal = document.getElementById('applyModal');
const openApplyModal = document.getElementById('openApplyModal');
const closeApplyModal = document.getElementById('closeApplyModal');
const applyForm = document.getElementById('apply-form');
const applyMsg = document.getElementById('apply-msg');

// ============================================================
// LOGIN ATTEMPT TRACKING (rate limiting)
// ============================================================
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 2 * 60 * 1000; // 2 minutes

function getLoginAttempts() {
    try {
        const stored = sessionStorage.getItem('loginAttempts');
        return stored ? JSON.parse(stored) : { count: 0, lockedUntil: null };
    } catch { return { count: 0, lockedUntil: null }; }
}

function setLoginAttempts(data) {
    sessionStorage.setItem('loginAttempts', JSON.stringify(data));
}

function recordFailedAttempt() {
    const attempts = getLoginAttempts();
    attempts.count += 1;
    if (attempts.count >= MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    }
    setLoginAttempts(attempts);
    return attempts;
}

function resetAttempts() {
    sessionStorage.removeItem('loginAttempts');
}

function isLockedOut() {
    const attempts = getLoginAttempts();
    if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
        return true;
    }
    if (attempts.lockedUntil && Date.now() >= attempts.lockedUntil) {
        resetAttempts();
    }
    return false;
}

function getRemainingLockoutSeconds() {
    const attempts = getLoginAttempts();
    if (!attempts.lockedUntil) return 0;
    return Math.max(0, Math.ceil((attempts.lockedUntil - Date.now()) / 1000));
}

// ============================================================
// TOAST NOTIFICATION (login page)
// ============================================================
function showLoginToast(message, type = 'success') {
    const existing = document.getElementById('login-toast');
    if (existing) existing.remove();

    const colors = {
        success: { bg: '#dcfce7', border: '#16a34a', text: '#166534', icon: '✓' },
        error: { bg: '#fee2e2', border: '#dc2626', text: '#991b1b', icon: '✕' },
        warning: { bg: '#fef3c7', border: '#d97706', text: '#92400e', icon: '⚠' },
        info: { bg: '#eff6ff', border: '#2563eb', text: '#1e40af', icon: 'ℹ' }
    };
    const c = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.id = 'login-toast';
    toast.style.cssText = `
        position: fixed; top: 24px; right: 24px; z-index: 99999;
        display: flex; align-items: center; gap: 12px;
        padding: 14px 22px; border-radius: 12px;
        background: ${c.bg}; border: 1px solid ${c.border};
        color: ${c.text}; font-size: 14px; font-weight: 500;
        font-family: 'Poppins', sans-serif;
        box-shadow: 0 10px 25px rgba(0,0,0,0.1);
        transform: translateX(120%); transition: transform 0.3s ease;
    `;
    toast.innerHTML = `<span style="font-size:18px;flex-shrink:0;">${c.icon}</span><span>${message}</span>`;

    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

    setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================================
// SESSION EXPIRED NOTICE
// ============================================================
function checkSessionExpired() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('expired') === '1' || sessionStorage.getItem('sessionExpired') === '1') {
        sessionStorage.removeItem('sessionExpired');
        // Clean URL
        if (params.get('expired')) {
            window.history.replaceState({}, '', window.location.pathname);
        }
        showSessionExpiredBanner();
    }
}

function showSessionExpiredBanner() {
    const banner = document.createElement('div');
    banner.className = 'session-expired-banner';
    banner.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>Your session has expired. Please sign in again.</span>
        <button onclick="this.parentElement.remove()" aria-label="Dismiss">&times;</button>
    `;
    const form = document.getElementById('login-form');
    if (form) {
        form.parentElement.insertBefore(banner, form);
    }
}

function showApplyMsg(text, ok) {
    if (!applyMsg) return;
    applyMsg.style.display = 'block';
    applyMsg.style.background = ok ? '#d4edda' : '#f8d7da';
    applyMsg.style.color = ok ? '#155724' : '#721c24';
    applyMsg.textContent = text;
}

function openApply() {
    if (!applyModal) return;
    applyModal.style.display = 'flex';
    if (applyMsg) applyMsg.style.display = 'none';
}

function closeApply() {
    if (!applyModal) return;
    applyModal.style.display = 'none';
    if (applyMsg) applyMsg.style.display = 'none';
    applyForm?.reset();
}

if (openApplyModal) {
    openApplyModal.addEventListener('click', (e) => {
        e.preventDefault();
        openApply();
    });
}

if (closeApplyModal) {
    closeApplyModal.addEventListener('click', (e) => {
        e.preventDefault();
        closeApply();
    });
}

if (applyModal) {
    applyModal.addEventListener('click', (e) => {
        if (e.target === applyModal) closeApply();
    });
}

if (applyForm) {
    applyForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const fullName = applyForm.fullName.value.trim();
        const email = applyForm.email.value.trim().toLowerCase();
        const roleRequested = applyForm.requestedRole.value;
        const submitBtn = applyForm.querySelector('button[type="submit"]');
        const original = submitBtn?.textContent || 'Submit Application';

        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting...';
            }
            if (!fullName || !email || !roleRequested) {
                throw new Error('Please complete the required fields.');
            }

            await addDoc(collection(db, "applicants"), {
                fullName,
                email,
                roleRequested,
                status: "pending",
                createdAt: serverTimestamp()
            });

            showApplyMsg('Application submitted for approval.', true);
            applyForm.reset();
        } catch (error) {
            console.error("Application Error:", error);
            const code = error?.code || "";
            if (code === "permission-denied") {
                showApplyMsg("Application failed due to permissions. Please try again.", false);
            } else {
                showApplyMsg(error.message || 'Application failed, try again.', false);
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = original;
            }
        }
    });
}

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = loginForm.email.value.trim().toLowerCase();
        const password = loginForm.password.value;
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;

        // Rate limiting check
        if (isLockedOut()) {
            const seconds = getRemainingLockoutSeconds();
            if (errorMsg) {
                errorMsg.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;vertical-align:middle;margin-right:6px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    Too many failed attempts. Try again in <strong>${Math.ceil(seconds / 60)} minute(s)</strong>.
                `;
                errorMsg.style.display = 'block';
                errorMsg.style.background = '#fef3c7';
                errorMsg.style.color = '#92400e';
            }
            return;
        }

        try {
            submitBtn.innerHTML = '<span class="btn-spinner"></span> Signing in...';
            submitBtn.disabled = true;
            if (errorMsg) errorMsg.style.display = 'none';

            // Persistence (important for correct session)
            await setPersistence(auth, browserLocalPersistence);

            // Login
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            const uid = user.uid;

            console.log("Logged in UID:", uid);

            // Get user document
            let userRef = doc(db, "users", uid);
            let userSnap = await getDoc(userRef);

            // Approval gate: user must have a Firestore profile created during approval
            if (!userSnap.exists()) {
                await signOut(auth);
                if (errorMsg) {
                    errorMsg.textContent = "Account not approved yet. Please apply for access and wait for approval.";
                    errorMsg.style.display = 'block';
                    errorMsg.style.background = '#fee2e2';
                    errorMsg.style.color = '#991b1b';
                }
                openApply();
                if (applyForm?.email) applyForm.email.value = email;
                if (applyForm?.fullName) applyForm.fullName.value = email.split('@')[0] || "";

                submitBtn.innerHTML = originalBtnText;
                submitBtn.disabled = false;
                return;
            }

            const userData = userSnap.data();

            // FIX: ensure role exists
            if (!userData.role) {
                await updateDoc(userRef, { role: "staff" });
                userData.role = "staff";
            }

            // Block inactive
            if (userData.status === "Inactive") {
                await signOut(auth);
                throw new Error("Account deactivated. Contact your administrator.");
            }

            // Reset failed attempts on success
            resetAttempts();

            // IMPORTANT: store correct user (fix wrong name issue)
            sessionStorage.setItem("currentUser", JSON.stringify({
                uid: uid,
                fullName: userData.fullName,
                role: userData.role
            }));

            console.log("User Data:", userData);

            // Show success toast before redirect
            showLoginToast(`Welcome back, ${userData.fullName || 'User'}! Redirecting...`, 'success');
            submitBtn.innerHTML = '<span class="btn-spinner"></span> Redirecting...';

            // Brief delay so user sees the success feedback
            await new Promise(resolve => setTimeout(resolve, 1200));

            // Redirect (no loop)
            if (userData.role === "owner") {
                window.location.replace("owner-dashboard.html");
            } else if (userData.role === "secretary") {
                window.location.replace("secretary-dashboard.html");
            } else {
                window.location.replace("staff-dashboard.html");
            }

        } catch (error) {
            console.error("Login Error:", error);

            // Record failed attempt
            const attempts = recordFailedAttempt();
            const remaining = MAX_ATTEMPTS - attempts.count;

            let msg = "Login failed.";

            if (
                error.code === 'auth/invalid-credential' ||
                error.code === 'auth/user-not-found' ||
                error.code === 'auth/wrong-password'
            ) {
                msg = "Invalid email or password.";
                if (remaining > 0 && remaining <= 3) {
                    msg += ` ${remaining} attempt(s) remaining.`;
                }
            } else if (error.code === 'auth/too-many-requests') {
                msg = "Account temporarily locked due to too many failed attempts. Try again later.";
            } else if (error.message) {
                msg = error.message;
            }

            if (attempts.count >= MAX_ATTEMPTS) {
                msg = "Too many failed attempts. Your account is temporarily locked for 2 minutes.";
            }

            if (errorMsg) {
                errorMsg.textContent = msg;
                errorMsg.style.display = 'block';
                errorMsg.style.background = '#fee2e2';
                errorMsg.style.color = '#991b1b';
                errorMsg.style.padding = '12px 16px';
                errorMsg.style.borderRadius = '10px';
                errorMsg.style.fontSize = '13px';
            } else {
                alert(msg);
            }

            submitBtn.innerHTML = originalBtnText;
            submitBtn.disabled = false;
        }
    });
}

// ============================================================
// FORGOT PASSWORD
// ============================================================
const forgotLink = document.querySelector('.forgot');
if (forgotLink) {
    forgotLink.style.cursor = 'pointer';
    forgotLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const emailInput = loginForm?.email;
        const email = emailInput?.value?.trim().toLowerCase();

        if (!email) {
            // Show inline error on email field
            if (emailInput) {
                emailInput.style.borderColor = '#dc2626';
                emailInput.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.08)';
            }
            if (errorMsg) {
                errorMsg.textContent = 'Please enter your email address first, then click "Forgot password?"';
                errorMsg.style.display = 'block';
                errorMsg.style.background = '#fef3c7';
                errorMsg.style.color = '#92400e';
                errorMsg.style.padding = '12px 16px';
                errorMsg.style.borderRadius = '8px';
                errorMsg.style.fontSize = '13px';
                errorMsg.style.marginTop = '12px';
            }
            return;
        }

        try {
            await sendPasswordResetEmail(auth, email);
            if (errorMsg) {
                errorMsg.textContent = `Password reset email sent to ${email}. Check your inbox.`;
                errorMsg.style.display = 'block';
                errorMsg.style.background = '#dcfce7';
                errorMsg.style.color = '#166534';
                errorMsg.style.padding = '12px 16px';
                errorMsg.style.borderRadius = '8px';
                errorMsg.style.fontSize = '13px';
                errorMsg.style.marginTop = '12px';
            }
        } catch (error) {
            console.error("Password reset error:", error);
            let msg = 'Failed to send reset email.';
            if (error.code === 'auth/user-not-found') {
                msg = 'No account found with this email address.';
            } else if (error.code === 'auth/invalid-email') {
                msg = 'Please enter a valid email address.';
            }
            if (errorMsg) {
                errorMsg.textContent = msg;
                errorMsg.style.display = 'block';
                errorMsg.style.background = '#fee2e2';
                errorMsg.style.color = '#991b1b';
                errorMsg.style.padding = '12px 16px';
                errorMsg.style.borderRadius = '8px';
                errorMsg.style.fontSize = '13px';
                errorMsg.style.marginTop = '12px';
            }
        }
    });
}

// ============================================================
// INLINE FORM VALIDATION (real-time feedback)
// ============================================================
if (loginForm) {
    const emailInput = loginForm.email;
    const passwordInput = loginForm.password;

    // Clear error styling on input
    [emailInput, passwordInput].forEach(input => {
        if (input) {
            input.addEventListener('input', () => {
                input.style.borderColor = '';
                input.style.boxShadow = '';
                if (errorMsg) errorMsg.style.display = 'none';
            });
        }
    });

    // Validate on blur
    if (emailInput) {
        emailInput.addEventListener('blur', () => {
            const val = emailInput.value.trim();
            if (val && !val.includes('@')) {
                emailInput.style.borderColor = '#dc2626';
                emailInput.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.08)';
            }
        });
    }
}

// ============================================================
// INIT: Check for session expiry notice on page load
// ============================================================
checkSessionExpired();
