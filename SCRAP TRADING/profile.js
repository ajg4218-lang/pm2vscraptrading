import { auth, db } from './firebase.js';
import { onAuthStateChanged, updatePassword, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

async function ensureUserDocument(user) {
    const userRef = doc(db, "users", user.uid);
    const docSnap = await getDoc(userRef);
    if (!docSnap.exists()) {
        await setDoc(userRef, {
            fullName: user.displayName || "New User",
            email: user.email,
            role: "staff",
            createdAt: serverTimestamp()
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const editProfileBtn = document.getElementById('editProfileBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const passwordModal = document.getElementById('passwordModal');
    const cancelBtn = document.getElementById('cancelBtn');
    const passwordForm = document.getElementById('passwordForm');
    const profileRoot = document.getElementById('profileRoot') || document.querySelector('.profile-page');
    
    let isEditing = false;
    let currentUser = null;

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            await ensureUserDocument(user);
        }
    });

    if (editProfileBtn) {
        editProfileBtn.addEventListener('click', async function() {
            const fullNameField = document.getElementById('fieldFullName') || document.querySelector('.detail-field');
            const fullNameP = document.getElementById('userName') || fullNameField?.querySelector('p');
            if (!fullNameField || !fullNameP) return;
            if (!isEditing) {
                profileRoot?.classList.add('edit-mode');
                editProfileBtn.textContent = 'Save Changes';
                isEditing = true;
                const input = document.createElement('input');
                input.type = 'text';
                input.value = fullNameP.textContent;
                input.className = 'edit-input';
                input.id = 'nameInput';
                fullNameField.appendChild(input);
                fullNameP.style.display = 'none';
            } else {
                const nameInput = document.getElementById('nameInput');
                const newName = nameInput.value.trim();
                if (!newName) return alert("Name cannot be empty.");
                try {
                    editProfileBtn.disabled = true;
                    await updateDoc(doc(db, "users", currentUser.uid), { fullName: newName });
                    location.reload();
                } catch (error) {
                    alert("Error: " + error.message);
                }
            }
        });
    }

    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', () => {
            passwordModal.style.display = 'block';
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            passwordModal.style.display = 'none';
        });
    }

    if (passwordForm) {
        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
            try {
                await reauthenticateWithCredential(currentUser, credential);
                await updatePassword(currentUser, newPassword);
                alert("Password updated!");
                passwordModal.style.display = 'none';
            } catch (error) {
                alert("Error: " + error.message);
            }
        });
    }
});
