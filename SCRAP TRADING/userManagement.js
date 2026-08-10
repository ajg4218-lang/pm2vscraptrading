import { app, auth, db } from './firebase.js';
import { createUserWithEmailAndPassword, fetchSignInMethodsForEmail, getAuth, signOut as signOutSecondary } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
    collection, 
    doc, 
    getDoc,
    setDoc,
    deleteDoc,
    onSnapshot, 
    query, 
    where,
    serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Standalone functions for STEP 5
window.loadApplicants = () => {
    const pendingApplicationsBody = document.getElementById('pendingApplicationsBody');
    const pendingCountBadge = document.getElementById('pendingCountBadge');
    
    if (!pendingApplicationsBody) return;

    console.log("Starting applicants query...");
    const applicantsRef = query(collection(db, "applicants"), where("status", "==", "pending"));

    onSnapshot(applicantsRef, (snapshot) => {
        pendingApplicationsBody.innerHTML = "";
        if (pendingCountBadge) pendingCountBadge.textContent = snapshot.size;

        if (snapshot.empty) {
            pendingApplicationsBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px;">No pending applicants</td></tr>`;
            return;
        }

        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const status = (data.status || "pending").toLowerCase();
            pendingApplicationsBody.innerHTML += `
                <tr>
                    <td>${data.fullName || "-"}</td>
                    <td>${data.email || "-"}</td>
                    <td>${data.roleRequested || "-"}</td>
                    <td><span class="status-badge status-${status}">${status}</span></td>
                    <td class="action-cell">
                        <button class="approve-btn" onclick="approveApplicant('${docSnap.id}')">Approve</button>
                        <button class="reject-btn" onclick="rejectApplicant('${docSnap.id}')">Reject</button>
                    </td>
                </tr>
            `;
        });
    });
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadApplicants?.();
});

// Approval functions
window.approveApplicant = async (id) => {
    if (!confirm("Approve this applicant?")) return;
    try {
        if (!id) throw new Error("Missing applicant data");
        console.log("Fetching applicant...");
        const applicantRef = doc(db, "applicants", id);
        const applicantSnap = await getDoc(applicantRef);
        if (!applicantSnap.exists()) {
            throw new Error("Missing applicant data");
        }
        
        const data = applicantSnap.data();
        const email = String(data.email || "").trim().toLowerCase();
        const roleRequested = String(data.roleRequested || "").trim().toLowerCase();
        const fullName = String(data.fullName || data.name || "").trim();

        if (!email) throw new Error("Missing email");
        if (!roleRequested) throw new Error("Missing applicant data");

        if (!auth.currentUser) {
            alert("Not authenticated.");
            return;
        }

        const tempPassword = prompt("Set a temporary password for this applicant (min 6 characters):");
        if (tempPassword === null) return;
        if ((tempPassword || "").length < 6) {
            alert("Password must be at least 6 characters.");
            return;
        }

        const approvalAuth = getApprovalAuth();
        console.log("Checking existing auth user...");
        const methods = await fetchSignInMethodsForEmail(approvalAuth, email);
        if (methods && methods.length > 0) {
            alert("This email already has an account. Cannot create a duplicate account.");
            return;
        }

        console.log("Creating Firebase Auth account...");
        let uid;
        try {
            const cred = await createUserWithEmailAndPassword(approvalAuth, email, tempPassword);
            uid = cred.user.uid;
        } finally {
            try {
                await signOutSecondary(approvalAuth);
            } catch {
            }
        }

        console.log("Updating Firestore user profile...");
        await setDoc(doc(db, "users", uid), {
            uid,
            fullName: fullName || email.split("@")[0] || "User",
            email,
            role: roleRequested,
            status: "Active",
            createdAt: serverTimestamp()
        }, { merge: true });

        console.log("Deleting applicant...");
        await deleteDoc(applicantRef);

        console.log("Approval successful");
        alert("Approved! Account created.");
    } catch (e) {
        const msg = e?.message || "Approval failed";
        if (msg.includes("Missing email")) return alert("Missing email");
        if (msg.includes("Missing applicant data")) return alert("Missing applicant data");
        if (msg.includes("Firestore write failed") || msg.includes("Firestore")) return alert("Firestore write failed");
        alert(msg);
    }
};

function getApprovalAuth() {
    const existing = getApps().find(a => a.name === "approvalApp");
    const approvalApp = existing || initializeApp(app.options, "approvalApp");
    return getAuth(approvalApp);
}

window.rejectApplicant = async (id) => {
    if (!confirm("Reject this applicant?")) return;
    try {
        await deleteDoc(doc(db, "applicants", id));
        alert("Rejected and removed.");
    } catch (e) {
        alert("Error: " + e.message);
    }
};
