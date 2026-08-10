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
        const originalBtnText = submitBtn.textContent;

        try {
            submitBtn.textContent = 'Signing in...';
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
                }
                openApply();
                if (applyForm?.email) applyForm.email.value = email;
                if (applyForm?.fullName) applyForm.fullName.value = email.split('@')[0] || "";

                submitBtn.textContent = originalBtnText;
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
                throw new Error("Account deactivated.");
            }

            // IMPORTANT: store correct user (fix wrong name issue)
            sessionStorage.setItem("currentUser", JSON.stringify({
                uid: uid,
                fullName: userData.fullName,
                role: userData.role
            }));

            console.log("User Data:", userData);

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

            let msg = "Login failed.";

            if (
                error.code === 'auth/invalid-credential' ||
                error.code === 'auth/user-not-found' ||
                error.code === 'auth/wrong-password'
            ) {
                msg = "Invalid email or password.";
            }

            if (errorMsg) {
                errorMsg.textContent = msg;
                errorMsg.style.display = 'block';
            } else {
                alert(msg);
            }

            submitBtn.textContent = originalBtnText;
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
