import { db } from './firebase.js';
import { 
    collection,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const applyForm = document.getElementById('apply-form');
const signupForm = document.getElementById('signup-form');
const msg = document.getElementById('msg');

if (applyForm) {
    applyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const fullName = applyForm.fullName.value.trim();
        const email = applyForm.email.value.trim().toLowerCase();
        const requestedRole = applyForm.requestedRole.value;
        const submitBtn = applyForm.querySelector('button[type="submit"]');

        try {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
            msg.style.display = 'none';

            if (!fullName || !email || !requestedRole) {
                throw new Error("Please fill in all required fields.");
            }

            await addDoc(collection(db, "applicants"), {
                fullName,
                email,
                roleRequested: requestedRole,
                status: "pending",
                createdAt: serverTimestamp()
            });

            msg.style.display = "block"; 
            msg.style.background = "#d4edda"; 
            msg.style.color = "#155724"; 
            msg.textContent = "Application submitted for approval."; 
            applyForm.reset();

        } catch (error) {
            console.error("Application Error:", error);
            const code = error?.code || "";
            msg.style.display = "block"; 
            msg.style.background = "#f8d7da"; 
            msg.style.color = "#721c24"; 
            msg.textContent = code === "permission-denied"
                ? "Application failed due to permissions. Please try again."
                : (error.message || "Application failed, try again."); 
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Application';
        }
    });
}

if (signupForm) {
    signupForm.style.display = 'none';
}
