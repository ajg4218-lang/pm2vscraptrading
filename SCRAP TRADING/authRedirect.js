import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 🔹 Hide loading
function hideLoading() {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        console.log("AuthRedirect: Hiding loading overlay");
        loadingOverlay.style.display = 'none';
        loadingOverlay.classList.add('hidden');
    }
}

// 🔹 Force hide on window load (Task 1 - guaranteed fallback)
window.addEventListener("load", () => {
    console.log("AuthRedirect: Window loaded - forcing hideLoading");
    hideLoading();
});

// 🔹 PROFILE UI
function updateProfileUI(data) {
    if (!data) return;

    const nameEls = document.querySelectorAll('#userName, #sidebarName, #profileHeaderName');
    const roleEls = document.querySelectorAll('#sidebarRole, #profileDetailRole');
    const emailEls = document.querySelectorAll('#profileDetailEmail, #profileHeaderEmail');
    const accountRoleEl = document.getElementById('profileAccountRole');
    const accountStatusEl = document.getElementById('profileAccountStatus');
    const roleBadgeEl = document.getElementById('profileRoleBadge');
    const statusBadgeEl = document.getElementById('profileStatusBadge');
    const createdAtEl = document.getElementById('profileCreatedAt');

    nameEls.forEach(el => {
        if (el) el.textContent = data.fullName || data.name || "User";
    });
    roleEls.forEach(el => {
        if (el) el.textContent = data.role || "staff";
    });
    emailEls.forEach(el => {
        if (el) el.textContent = data.displayEmail || data.email || "";
    });

    const role = String(data.role || "staff").toLowerCase();
    const status = String(data.status || "active").toLowerCase();

    if (accountRoleEl) accountRoleEl.textContent = role;
    if (accountStatusEl) accountStatusEl.textContent = status;

    if (roleBadgeEl) {
        roleBadgeEl.textContent = role;
        roleBadgeEl.classList.remove('role-owner-badge', 'role-secretary-badge', 'role-staff-badge');
        if (role === "owner") roleBadgeEl.classList.add('role-owner-badge');
        else if (role === "secretary") roleBadgeEl.classList.add('role-secretary-badge');
        else roleBadgeEl.classList.add('role-staff-badge');
    }

    if (statusBadgeEl) {
        statusBadgeEl.textContent = status;
        statusBadgeEl.classList.remove('status-active', 'status-inactive', 'status-pending');
        if (status === "inactive") statusBadgeEl.classList.add('status-inactive');
        else if (status === "pending") statusBadgeEl.classList.add('status-pending');
        else statusBadgeEl.classList.add('status-active');
    }

    if (createdAtEl) {
        const ts = data.createdAt;
        const dt = ts?.seconds ? new Date(ts.seconds * 1000) : (ts instanceof Date ? ts : null);
        createdAtEl.textContent = dt ? dt.toLocaleString() : "";
    }

    // Also update avatar if exists
    const avatarEl = document.getElementById('sidebarAvatar') || document.getElementById('userAvatar');
    if (avatarEl && data.fullName) {
        avatarEl.textContent = data.fullName.charAt(0).toUpperCase();
    }

    console.log("AuthRedirect: Profile UI updated");
}

// 🔹 IMMEDIATELY show UI from sessionStorage if available (prevents blank screen)
(function initSessionUI() {
    try {
        const storedUser = sessionStorage.getItem('currentUser');
        if (storedUser) {
            const userData = JSON.parse(storedUser);
            console.log("AuthRedirect: Restoring UI from sessionStorage:", userData.role);
            updateProfileUI(userData);
        }
    } catch (e) {
        console.warn("AuthRedirect: Could not restore session:", e);
    }
    // Always hide loading overlay after short delay (prevents infinite loading)
    setTimeout(hideLoading, 1500);
})();

// 🔹 Fail-safe timeout (Hide loading after 3 seconds regardless)
setTimeout(() => {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay && loadingOverlay.style.display !== 'none') {
        console.warn("AuthRedirect: Fail-safe triggered - hiding loading overlay after 3s");
        hideLoading();
    }
}, 3000);

// 🔹 MAIN AUTH CHECK (NO LOOP)
console.log("AuthRedirect: Initializing auth state check...");
onAuthStateChanged(auth, async (user) => {
    console.log("AuthRedirect: Auth state changed. User:", user ? user.uid : "None");

    const path = window.location.pathname.toLowerCase();
    const isAuthExemptPage = path.includes("login.html") || path.includes("signup.html") || path === "/" || path.endsWith("/");

    // 🔹 If on login/signup page, hide loading immediately
    if (isAuthExemptPage) {
        console.log("AuthRedirect: On auth-exempt page (" + path + "), skipping auto-redirect and hiding loading.");
        hideLoading();
        // Do NOT redirect away from login/signup automatically even if logged in
        // This allows manual logout or switching accounts
        return;
    }

    // ❌ Not logged in and not on an exempt page
    if (!user) {
        console.log("AuthRedirect: Not logged in on protected page, redirecting to login.html");
        hideLoading(); // Ensure loading is hidden before redirect
        window.location.replace("login.html");
        return;
    }

    try {
        console.log("AuthRedirect: Fetching user data from Firestore...");
        // 🔹 Get user data ONCE (no onSnapshot)
        const docSnap = await getDoc(doc(db, "users", user.uid));

        console.log("AuthRedirect: User data fetched");

        if (!docSnap.exists()) {
            console.warn("AuthRedirect: User document missing in Firestore. Signing out and redirecting to login.");
            hideLoading();
            await signOut(auth);
            window.location.replace("login.html");
            return;
        }

        const data = docSnap.data();

        console.log("AuthRedirect: User data received. Role:", data.role);

        // 🔹 SAVE SESSION (IMPORTANT FIX)
        sessionStorage.setItem("currentUser", JSON.stringify({
            uid: user.uid,
            fullName: data.fullName,
            role: data.role
        }));

        // 🔹 Update UI
        updateProfileUI(data);
        console.log("AuthRedirect: Profile updated");

        // 🔹 ROLE PROTECTION (NO LOOP)
        let unauthorized = false;
        if (path.includes("owner") && data.role !== "owner") unauthorized = true;
        if (path.includes("secretary") && data.role !== "secretary") unauthorized = true;
        if (path.includes("staff") && data.role !== "staff") unauthorized = true;

        if (unauthorized) {
            console.warn("AuthRedirect: Unauthorized access to role-protected page. Redirecting to login.html");
            hideLoading();
            window.location.replace("login.html");
            return;
        }

        console.log("AuthRedirect: Authorization successful");
        console.log("AuthRedirect: Loading hidden");
        hideLoading();

    } catch (err) {
        console.error("AuthRedirect: Error during auth/role check:", err);
        hideLoading();
    }
});

// 🔹 LOGOUT (FIXED)
window.logoutUser = async () => {
    try {
        sessionStorage.clear();
        localStorage.clear();
        await signOut(auth);
        window.location.replace("login.html");
    } catch (error) {
        console.error("Logout error:", error);
    }
};

// 🔹 ATTACH LOGOUT HANDLER TO BUTTONS
document.addEventListener('DOMContentLoaded', () => {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            console.log("Logout button clicked");
            window.logoutUser();
        });
    }
});
