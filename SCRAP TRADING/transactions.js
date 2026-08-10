import { auth, db, storage } from './firebase.js';
import { 
    collection, 
    addDoc, 
    onSnapshot, 
    query, 
    orderBy, 
    serverTimestamp, 
    doc, 
    getDoc,
    updateDoc, 
    increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

let currentUser = null;
let inventoryItems = [];
const migratingReceiptIds = new Set();

async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.onload = (e) => resolve(String(e.target.result || ""));
        reader.readAsDataURL(file);
    });
}

async function compressImageToBlob(file, maxSize = 1600, quality = 0.82) {
    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("Invalid image"));
            el.src = objectUrl;
        });

        const width = img.width || maxSize;
        const height = img.height || maxSize;
        const scale = Math.min(1, maxSize / Math.max(width, height));

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error("Canvas not supported");

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((resolve) => {
            canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
        });
        if (!blob) throw new Error("Failed to compress image");
        return blob;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl || "").split(',');
    if (parts.length < 2) throw new Error("Invalid data URL");
    const meta = parts[0];
    const base64 = parts.slice(1).join(',');
    const match = /data:(.*?);base64/i.exec(meta);
    const contentType = match?.[1] || 'application/octet-stream';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType });
}

async function uploadReceiptFile(file) {
    if (!currentUser) throw new Error("Not authenticated");

    const isPdf = (file.type || "").toLowerCase() === "application/pdf";
    const isImage = (file.type || "").toLowerCase().startsWith("image/");

    let uploadBlobOrFile = file;
    let contentType = file.type || "application/octet-stream";
    let fileName = file.name || "receipt";

    if (isImage) {
        uploadBlobOrFile = await compressImageToBlob(file);
        contentType = uploadBlobOrFile.type || "image/jpeg";
        fileName = "receipt.jpg";
    } else if (isPdf) {
        contentType = "application/pdf";
        fileName = file.name || "receipt.pdf";
    }

    const safeName = fileName.replace(/[^\w.\-]+/g, "_");
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}_${safeName}`;
    const storageRef = ref(storage, `receipts/${currentUser.uid}/${key}`);

    const snapshot = await uploadBytes(storageRef, uploadBlobOrFile, { contentType });
    const url = await getDownloadURL(snapshot.ref);

    return { url, contentType, fileName };
}

async function migrateBase64ReceiptIfNeeded(transactionId, receiptUrl) {
    if (!receiptUrl || typeof receiptUrl !== "string") return;
    if (!receiptUrl.startsWith("data:")) return;
    if (migratingReceiptIds.has(transactionId)) return;
    migratingReceiptIds.add(transactionId);

    try {
        const blob = dataUrlToBlob(receiptUrl);
        if (!currentUser) return;
        const fileName = "receipt.jpg";
        const key = `migrated_${transactionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileName}`;
        const storageRef = ref(storage, `receipts/${currentUser.uid}/${key}`);
        const snapshot = await uploadBytes(storageRef, blob, { contentType: blob.type || "image/jpeg" });
        const url = await getDownloadURL(snapshot.ref);

        await updateDoc(doc(db, "transactions", transactionId), {
            receiptUrl: url,
            receiptContentType: blob.type || "image/jpeg",
            receiptFileName: fileName,
            receiptMigratedAt: serverTimestamp()
        });
    } catch (e) {
        console.warn("Receipt migration failed for", transactionId, e);
    } finally {
        migratingReceiptIds.delete(transactionId);
    }
}

window.openReceiptModal = (url, contentType, fileName) => {
    const modal = document.getElementById('receiptModal');
    const modalImg = document.getElementById('modalImage');
    const downloadLink = document.getElementById('downloadReceipt');
    if (modal && modalImg) {
        const isPdf = (contentType || "").toLowerCase() === "application/pdf" || String(url || "").toLowerCase().includes(".pdf");
        if (isPdf) {
            window.open(url, "_blank");
            return;
        }
        modalImg.src = url;
        if (downloadLink) {
            downloadLink.href = url;
            downloadLink.download = fileName || "receipt";
        }
        modal.style.display = 'flex';
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const transactionForm = document.getElementById('transactionForm');
    const itemSelect = document.getElementById('transItemName');
    const transactionsTableBody = document.getElementById('transactionsTableBody');
    const receiptFileInput = document.getElementById('transReceiptFile');

    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = user;
            loadInventoryItems(itemSelect);
            loadTransactions(transactionsTableBody);
        }
    });

    if (transactionForm) {
        // Real-time category update when item is selected
        itemSelect.addEventListener('change', () => {
            const selectedItem = inventoryItems.find(i => i.id === itemSelect.value);
            const transCategory = document.getElementById('transCategory');
            if (transCategory && selectedItem) {
                transCategory.value = selectedItem.category || '';
            }
        });

        transactionForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = itemSelect.value;
            const selectedItem = inventoryItems.find(i => i.id === itemId);
            const qtySold = parseFloat(document.getElementById('transQty').value);
            const buyerName = document.getElementById('transBuyer').value.trim();
            const notes = document.getElementById('transNotes').value.trim();
            const receiptFile = receiptFileInput.files[0];

            if (!itemId || isNaN(qtySold) || !buyerName || !receiptFile) {
                return alert("Please fill all fields.");
            }

            try {
                const btnSave = document.getElementById('btnSaveTransaction');
                btnSave.disabled = true;
                btnSave.textContent = "Saving...";

                const uploaded = await uploadReceiptFile(receiptFile);
                await addDoc(collection(db, "transactions"), {
                    itemId,
                    itemName: selectedItem.itemName,
                    category: selectedItem.category,
                    quantitySold: qtySold,
                    buyerName,
                    notes: notes || "",
                    receiptUrl: uploaded.url,
                    receiptContentType: uploaded.contentType,
                    receiptFileName: uploaded.fileName,
                    uploadedAt: serverTimestamp()
                });
                await updateDoc(doc(db, "inventory", itemId), {
                    quantity: increment(-qtySold),
                    lastUpdated: serverTimestamp()
                });
                alert("Transaction saved!");
                transactionForm.reset();
                if (document.getElementById('receiptPreviewContainer')) {
                    document.getElementById('receiptPreviewContainer').style.display = 'none';
                }
            } catch (error) {
                alert("Error: " + error.message);
            } finally {
                const btnSave = document.getElementById('btnSaveTransaction');
                btnSave.disabled = false;
                btnSave.textContent = "Save Transaction";
            }
        });
    }

    // Receipt File Preview logic
    if (receiptFileInput) {
        receiptFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            const container = document.getElementById('receiptPreviewContainer');
            const imgPreview = document.getElementById('receiptPreviewImage');
            const pdfPreview = document.getElementById('receiptPdfPreview');
            const pdfName = document.getElementById('receiptFileName');
            
            if (file && container && imgPreview) {
                const isPdf = (file.type || "").toLowerCase() === "application/pdf";
                if (isPdf) {
                    if (pdfName) pdfName.textContent = file.name || "receipt.pdf";
                    if (pdfPreview) pdfPreview.style.display = 'flex';
                    imgPreview.style.display = 'none';
                } else {
                    const url = URL.createObjectURL(file);
                    imgPreview.src = url;
                    imgPreview.style.display = 'block';
                    if (pdfPreview) pdfPreview.style.display = 'none';
                }
                container.style.display = 'block';
            }
        });
    }

    const btnRemoveReceipt = document.getElementById('btnRemoveReceipt');
    if (btnRemoveReceipt) {
        btnRemoveReceipt.addEventListener('click', () => {
            if (receiptFileInput) receiptFileInput.value = '';
            if (document.getElementById('receiptPreviewContainer')) {
                document.getElementById('receiptPreviewContainer').style.display = 'none';
            }
        });
    }
});

function loadInventoryItems(select) {
    onSnapshot(collection(db, "inventory"), (snapshot) => {
        inventoryItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        select.innerHTML = '<option value="">Select Item</option>';
        inventoryItems.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = `${item.itemName} (${item.quantity}kg available)`;
            select.appendChild(opt);
        });
    });
}

function loadTransactions(tbody) {
    const q = query(collection(db, "transactions"), orderBy("uploadedAt", "desc"));
    onSnapshot(q, (snapshot) => {
        tbody.innerHTML = snapshot.empty ? '<tr><td colspan="7">No records</td></tr>' : '';
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const date = data.uploadedAt ? new Date(data.uploadedAt.seconds * 1000).toLocaleString() : 'N/A';

            if (data.receiptUrl && typeof data.receiptUrl === "string" && data.receiptUrl.startsWith("data:")) {
                migrateBase64ReceiptIfNeeded(docSnap.id, data.receiptUrl);
            }
            
            const tr = document.createElement('tr');
            const receiptUrl = data.receiptUrl || '';
            const receiptType = data.receiptContentType || '';
            const receiptName = data.receiptFileName || 'receipt';
            const isPdf = receiptType.toLowerCase() === "application/pdf" || String(receiptUrl).toLowerCase().includes(".pdf");

            const receiptCell = isPdf
                ? `<button style="padding: 6px 10px; border: 1px solid #e2e8f0; background: #fff; border-radius: 8px; cursor: pointer; font-weight: 600;" onclick="window.openReceiptModal('${receiptUrl}', '${receiptType}', '${receiptName}')">View PDF</button>`
                : `<img src="${receiptUrl}" 
                         style="width: 50px; height: 50px; object-fit: cover; border-radius: 8px; border: 1px solid #e2e8f0; cursor: pointer; transition: transform 0.2s;" 
                         onclick="window.openReceiptModal('${receiptUrl}', '${receiptType}', '${receiptName}')"
                         onmouseover="this.style.transform='scale(1.1)'"
                         onmouseout="this.style.transform='scale(1)'"
                         alt="Receipt">`;

            tr.innerHTML = `
                <td><strong>${data.itemName || 'N/A'}</strong></td>
                <td><span class="badge available">${data.category || 'N/A'}</span></td>
                <td>${data.quantitySold || 0} kg</td>
                <td>${data.buyerName || 'N/A'}</td>
                <td>${date}</td>
                <td>
                    ${receiptUrl ? receiptCell : '-'}
                </td>
                <td style="font-size: 12px; color: #718096; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${data.notes || '-'}
                </td>
            `;
            tbody.appendChild(tr);
        });
    });
}
