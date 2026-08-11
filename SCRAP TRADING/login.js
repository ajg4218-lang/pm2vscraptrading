/**
 * PM2V Scrap Trading - Login Module
 * Handles user authentication, role-based redirects, forgot password, and apply-for-access modal.
 */

import { auth, db } from './firebase.js';
import {
    signInWithEmailAndPassword,
    signOut,
    setPersistence,
    browserLocalPersistence,
    sendPasswordResetEmail,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
    doc,
    getDoc,
    updateDoc,
    addDoc,
    collection,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ============================================================
// DOM ELEMENTS
// ============================================================
const loginForm = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');
const applyModal = document.getElementById('applyModal');
const openApplyModalBtn = document.getElementById('openApplyModal');
const closeApplyModalBtn = document.getElementById('closeApplyModal');
const applyForm = document.getElementById('apply-form');
const applyMsg = document.getElementById('apply-msg');

// ============================================================
// ROLE-BASED REDIRECT MAP
// ============================================================
const ROLE_DASHBOARDS = {
    owner: 'owner-dashboard.html',
    secretary: 'secretary-dashboard.html',
    staff: 'staff-dashboard.html'
};

// ============================================================
// AUTO-REDIRECT IF ALREADY LOGGED IN
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (userSnap.exists()) {
            const userData = userSnap.data();
            const role = (userData.role || 'staff').toLowerCase();

            // User is already authenticated and has a valid profile - redirect to their dashboard
            if (userData.status !== "Inactive") {
                sessionStorage.setItem("currentUser", JSON.stringify({
                    uid: user.uid,
                    fullName: userData.fullName || '',
                    role: role
                }));

                const destination = ROLE_DASHBOARDS[role] || ROLE_DASHBOARDS.staff;
                console.log("Login: User already authenticated, redirecting to", destination);
                window.location.replace(destination);
            }
        }
    } catch (err) {
        // Silently fail - user can still log in manually
        console.warn("Login: Auto-redirect check failed:", err.message);
    }
});

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function showError(message, type = 'error') {
    if (!errorMsg) return;

    const styles = {
        error: { bg: '#fee2e2', color: '#991b1b' },
        success: { bg: '#dcfce7', color: '#166534' },
        warning: { bg: '#fef3c7', color: '#92400e' },
        info: { bg: '#eff6ff', color: '#1e40af' }
    };
    const s = styles[type] || styles.error;

    errorMsg.textContent = message;
    errorMsg.style.display = 'block';
    errorMsg.style.background = s.bg;
    errorMsg.style.color = s.color;
    errorMsg.style.padding = '12px 16px';
    errorMsg.style.borderRadius = '8px';
    errorMsg.style.fontSize = '13px';
    errorMsg.style.marginTop = '12px';
}

function hideError() {
    if (errorMsg) errorMsg.style.display = 'none';
}

function setButtonLoading(btn, loading, originalText) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
        btn.innerHTML = `<span>Signing in...</span>`;
        btn.style.opacity = '0.7';
    } else {
        btn.innerHTML = `<span>${originalText}</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
        btn.style.opacity = '1';
    }
}

// ============================================================
// LOGIN FORM HANDLER
// ============================================================
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = loginForm.email.value.trim().toLowerCase();
        const password = loginForm.password.value;
        const submitBtn = loginForm.querySelector('button[type="submit"]');

        // Client-side validation
        if (!email || !password) {
            showError('Please enter both email and password.', 'warning');
            return;
        }

        if (!email.includes('@') || !email.includes('.')) {
            showError('Please enter a valid email address.', 'warning');
            return;
        }

        try {
            setButtonLoading(submitBtn, true);
            hideError();

            // Set persistence so the session survives page reloads
            await setPersistence(auth, browserLocalPersistence);

            // Authenticate with Firebase
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            console.log("Login: Authenticated UID:", user.uid);

            // Fetch user profile from Firestore
            const userRef = doc(db, "users", user.uid);
            const userSnap = await getDoc(userRef);

            // Gate: User must have a Firestore profile (created during approval)
            if (!userSnap.exists()) {
                await signOut(auth);
                showError("Your account hasn't been approved yet. Please apply for access and wait for admin approval.", 'warning');
                openApply();
                if (applyForm?.email) applyForm.email.value = email;
                if (applyForm?.fullName) applyForm.fullName.value = email.split('@')[0] || '';
                setButtonLoading(submitBtn, false, 'Sign In');
                return;
            }

            const userData = userSnap.data();

            // Ensure role field exists (fallback to staff)
            let role = (userData.role || '').toLowerCase();
            if (!role) {
                await updateDoc(userRef, { role: "staff" });
                role = "staff";
            }

            // Block inactive accounts
            if (userData.status === "Inactive" || userData.status === "inactive") {
                await signOut(auth);
                showError("Your account has been deactivated. Please contact the administrator.", 'error');
                setButtonLoading(submitBtn, false, 'Sign In');
                return;
            }

            // Block pending accounts
            if (userData.status === "pending") {
                await signOut(auth);
                showError("Your account is still pending approval. Please wait for the administrator to approve your access.", 'warning');
                setButtonLoading(submitBtn, false, 'Sign In');
                return;
            }

            // Store session data for quick UI rendering on dashboards
            sessionStorage.setItem("currentUser", JSON.stringify({
                uid: user.uid,
                fullName: userData.fullName || '',
                email: userData.email || email,
                role: role
            }));

            console.log("Login: User role:", role, "- Redirecting...");

            // Redirect to role-appropriate dashboard
            const destination = ROLE_DASHBOARDS[role] || ROLE_DASHBOARDS.staff;
            window.location.replace(destination);

        } catch (error) {
            console.error("Login Error:", error);

            let msg = "Login failed. Please try again.";
            switch (error.code) {
                case 'auth/invalid-credential':
                case 'auth/user-not-found':
                case 'auth/wrong-password':
                    msg = "Invalid email or password. Please check your credentials.";
                    break;
                case 'auth/invalid-email':
                    msg = "Please enter a valid email address.";
                    break;
                case 'auth/user-disabled':
                    msg = "This account has been disabled. Contact the administrator.";
                    break;
                case 'auth/too-many-requests':
                    msg = "Too many failed attempts. Please wait a few minutes before trying again.";
                    break;
                case 'auth/network-request-failed':
                    msg = "Network error. Please check your internet connection.";
                    break;
                default:
                    if (error.message) msg = error.message;
            }

            showError(msg, 'error');
            setButtonLoading(submitBtn, false, 'Sign In');
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
            if (emailInput) {
                emailInput.style.borderColor = '#dc2626';
                emailInput.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.08)';
            }
            showError('Please enter your email address first, then click "Forgot password?"', 'warning');
            return;
        }

        if (!email.includes('@')) {
            showError('Please enter a valid email address.', 'warning');
            return;
        }

        try {
            await sendPasswordResetEmail(auth, email);
            showError(`Password reset email sent to ${email}. Check your inbox (and spam folder).`, 'success');
        } catch (error) {
            console.error("Password reset error:", error);
            let msg = 'Failed to send reset email. Please try again.';
            if (error.code === 'auth/user-not-found') {
                msg = 'No account found with this email address.';
            } else if (error.code === 'auth/invalid-email') {
                msg = 'Please enter a valid email address.';
            } else if (error.code === 'auth/too-many-requests') {
                msg = 'Too many requests. Please wait before trying again.';
            }
            showError(msg, 'error');
        }
    });
}

// ============================================================
// APPLY FOR ACCESS MODAL
// ============================================================
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

function showApplyMessage(text, success) {
    if (!applyMsg) return;
    applyMsg.style.display = 'block';
    applyMsg.style.background = success ? '#dcfce7' : '#fee2e2';
    applyMsg.style.color = success ? '#166534' : '#991b1b';
    applyMsg.style.padding = '12px 16px';
    applyMsg.style.borderRadius = '8px';
    applyMsg.style.fontSize = '13px';
    applyMsg.style.marginTop = '12px';
    applyMsg.textContent = text;
}

if (openApplyModalBtn) {
    openApplyModalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openApply();
    });
}

if (closeApplyModalBtn) {
    closeApplyModalBtn.addEventListener('click', (e) => {
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
        const originalText = submitBtn?.textContent || 'Submit Application';

        if (!fullName || !email || !roleRequested) {
            showApplyMessage('Please complete all required fields.', false);
            return;
        }

        if (!email.includes('@') || !email.includes('.')) {
            showApplyMessage('Please enter a valid email address.', false);
            return;
        }

        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting...';
            }

            await addDoc(collection(db, "applicants"), {
                fullName,
                email,
                roleRequested,
                status: "pending",
                createdAt: serverTimestamp()
            });

            showApplyMessage('Application submitted successfully! You will be notified once approved.', true);
            applyForm.reset();
        } catch (error) {
            console.error("Application Error:", error);
            if (error.code === "permission-denied") {
                showApplyMessage("Submission failed due to permissions. Please try again later.", false);
            } else {
                showApplyMessage(error.message || 'Application failed. Please try again.', false);
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
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
                hideError();
            });
        }
    });

    // Validate email format on blur
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
