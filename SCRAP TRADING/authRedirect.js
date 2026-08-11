/**
 * PM2V Scrap Trading - Auth Redirect & Role Protection
 * 
 * This module runs on every protected page (dashboards, profiles, etc.).
 * It checks authentication state, enforces role-based access, updates the sidebar UI,
 * and provides the logout function.
 */

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ============================================================
// CONFIGURATION
// ============================================================

// Pages that don't require authentication
const AUTH_EXEMPT_PAGES = ['login.html', 'signup.html', 'about.html', 'faqs.html', 'privacy-policy.html', 'terms-of-service.html'];

// Map each protected page to the role(s) that can access it
const PAGE_ROLE_ACCESS = {
    // Owner pages
    'owner-dashboard.html': ['owner'],
    'owner-physical-inventory.html': ['owner'],
    'owner-reports.html': ['owner'],
    'owner-user-management.html': ['owner'],
    // Secretary pages
    'secretary-dashboard.html': ['secretary'],
    'secretary-physical-inventory.html': ['secretary'],
    'secretary-transactions.html': ['secretary'],
    'secretary-reports.html': ['secretary'],
    'secretary-profile.html': ['secretary'],
    // Staff pages
    'staff-dashboard.html': ['staff'],
    'staff-physical-inventory.html': ['staff'],
    'staff-collection-log.html': ['staff'],
    'staff-profile.html': ['staff'],
    // Shared pages accessible by owner (and secretary for transactions)
    'transactions.html': ['owner', 'secretary'],
    'profile.html': ['owner']
};

// Role-to-dashboard redirect map
const ROLE_DASHBOARDS = {
    owner: 'owner-dashboard.html',
    secretary: 'secretary-dashboard.html',
    staff: 'staff-dashboard.html'
};

// ============================================================
// LOADING OVERLAY
// ============================================================
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        setTimeout(() => {
            overlay.style.display = 'none';
            overlay.classList.add('hidden');
        }, 200);
    }
}

function showLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.style.pointerEvents = 'auto';
        overlay.classList.remove('hidden');
    }
}

// ============================================================
// PROFILE UI UPDATE
// ============================================================
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

    const displayName = data.fullName || data.name || "User";
    const role = String(data.role || "staff").toLowerCase();
    const status = String(data.status || "active").toLowerCase();

    nameEls.forEach(el => { if (el) el.textContent = displayName; });
    roleEls.forEach(el => { if (el) el.textContent = role.charAt(0).toUpperCase() + role.slice(1); });
    emailEls.forEach(el => { if (el) el.textContent = data.displayEmail || data.email || ""; });

    if (accountRoleEl) accountRoleEl.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    if (accountStatusEl) accountStatusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);

    if (roleBadgeEl) {
        roleBadgeEl.textContent = role.charAt(0).toUpperCase() + role.slice(1);
        roleBadgeEl.classList.remove('role-owner-badge', 'role-secretary-badge', 'role-staff-badge');
        if (role === "owner") roleBadgeEl.classList.add('role-owner-badge');
        else if (role === "secretary") roleBadgeEl.classList.add('role-secretary-badge');
        else roleBadgeEl.classList.add('role-staff-badge');
    }

    if (statusBadgeEl) {
        statusBadgeEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
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

    // Update avatar initial
    const avatarEl = document.getElementById('sidebarAvatar') || document.getElementById('userAvatar');
    if (avatarEl && displayName) {
        avatarEl.textContent = displayName.charAt(0).toUpperCase();
    }
}

// ============================================================
// RESTORE UI FROM SESSION (prevents blank flash)
// ============================================================
(function restoreSessionUI() {
    try {
        const stored = sessionStorage.getItem('currentUser');
        if (stored) {
            const userData = JSON.parse(stored);
            updateProfileUI(userData);
        }
    } catch (e) {
        // Non-critical, will be populated by auth check
    }
})();

// ============================================================
// HELPER: Get current page filename
// ============================================================
function getCurrentPage() {
    const path = window.location.pathname;
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1].toLowerCase() || 'index.html';
}

// ============================================================
// HELPER: Check if page is auth-exempt
// ============================================================
function isAuthExempt(page) {
    return AUTH_EXEMPT_PAGES.some(exempt => page.includes(exempt)) || page === '' || page === '/';
}

// ============================================================
// MAIN AUTH STATE LISTENER
// ============================================================
onAuthStateChanged(auth, async (user) => {
    const currentPage = getCurrentPage();

    // Skip auth logic on login/signup and public pages
    if (isAuthExempt(currentPage)) {
        hideLoading();
        return;
    }

    // Not logged in on a protected page -> redirect to login
    if (!user) {
        console.log("AuthRedirect: No user session, redirecting to login");
        hideLoading();
        window.location.replace("login.html");
        return;
    }

    try {
        // Fetch user document from Firestore
        const userSnap = await getDoc(doc(db, "users", user.uid));

        if (!userSnap.exists()) {
            console.warn("AuthRedirect: No Firestore profile found, signing out");
            hideLoading();
            await signOut(auth);
            sessionStorage.clear();
            window.location.replace("login.html");
            return;
        }

        const data = userSnap.data();
        const role = (data.role || 'staff').toLowerCase();

        // Block inactive/pending users
        const status = (data.status || 'active').toLowerCase();
        if (status === 'inactive' || status === 'pending') {
            console.warn("AuthRedirect: Account not active, signing out");
            hideLoading();
            await signOut(auth);
            sessionStorage.clear();
            window.location.replace("login.html");
            return;
        }

        // Save session for quick UI restore
        sessionStorage.setItem("currentUser", JSON.stringify({
            uid: user.uid,
            fullName: data.fullName || '',
            email: data.email || user.email || '',
            role: role,
            status: status
        }));

        // Update sidebar/profile UI
        updateProfileUI(data);

        // ============================================================
        // ROLE-BASED ACCESS CONTROL
        // ============================================================
        const allowedRoles = PAGE_ROLE_ACCESS[currentPage];

        if (allowedRoles && !allowedRoles.includes(role)) {
            // User doesn't have permission for this page
            console.warn(`AuthRedirect: Role "${role}" cannot access "${currentPage}". Redirecting to correct dashboard.`);
            hideLoading();
            const correctDashboard = ROLE_DASHBOARDS[role] || ROLE_DASHBOARDS.staff;
            window.location.replace(correctDashboard);
            return;
        }

        // If page is not in the access map and not exempt, allow access
        // (for any future pages that haven't been mapped yet)
        console.log("AuthRedirect: Access granted for", role, "on", currentPage);
        hideLoading();

    } catch (err) {
        console.error("AuthRedirect: Error during auth check:", err);
        hideLoading();
        // Don't redirect on transient errors - let the user stay on the page
        // but show the page content so they can at least see something
    }
});

// ============================================================
// FAIL-SAFE: Hide loading after 4 seconds no matter what
// ============================================================
setTimeout(() => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay && overlay.style.display !== 'none') {
        console.warn("AuthRedirect: Fail-safe triggered - hiding loading after 4s");
        hideLoading();
    }
}, 4000);

// ============================================================
// LOGOUT
// ============================================================
window.logoutUser = async () => {
    try {
        showLoading();
        sessionStorage.clear();
        localStorage.removeItem('currentUser');
        await signOut(auth);
        window.location.replace("login.html");
    } catch (error) {
        console.error("Logout error:", error);
        // Force redirect even if signOut fails
        window.location.replace("login.html");
    }
};

// ============================================================
// ATTACH LOGOUT TO BUTTONS
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            window.logoutUser();
        });
    }
});
