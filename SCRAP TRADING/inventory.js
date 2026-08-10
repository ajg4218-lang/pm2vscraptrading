import { auth, db } from './firebase.js';
import { escapeHtml, showToast, showConfirm, validateRequired, validateNumber, clearFieldErrors } from './utils.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { 
    collection, 
    doc, 
    getDoc, 
    getDocs, 
    setDoc, 
    updateDoc, 
    onSnapshot, 
    serverTimestamp,
    query,
    orderBy,
    limit,
    where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const defaultItems = [ 
    { itemName: "Paleta kahoy - Palochina", category: "Wood", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Paleta kahoy - Good Lumber", category: "Wood", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Paletang Plastic", category: "Plastic", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Karton", category: "Paper", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Bakal", category: "Metal", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Jumbo Bag", category: "Plastic", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Sako", category: "Fiber", quantity: 0, unit: "kg", condition: "Good" }, 
    { itemName: "Panggatong", category: "Wood", quantity: 0, unit: "kg", condition: "Good" } 
];

let userRole = null;
let editingRowId = null;
let lastSnapshot = null;
let currentCategoryFilter = 'All';

async function seedInventoryIfEmpty() {
    const invRef = collection(db, "inventory");
    const snapshot = await getDocs(invRef);
    
    if (snapshot.empty) {
        console.log("Seeding default inventory items...");
        for (const item of defaultItems) {
            const itemRef = doc(invRef); 
            await setDoc(itemRef, {
                ...item,
                dateAdded: serverTimestamp(),
                lastUpdated: serverTimestamp()
            });
        }
    }
}

// Standalone load function for STEP 5
window.loadInventory = async () => {
    onAuthStateChanged(auth, async (user) => {
        if (!user) return;
        
        console.log("Inventory Module: Initializing for", user.uid);
        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists()) {
                userRole = userDoc.data().role;
            }
            
            await seedInventoryIfEmpty();
            
            console.log("Starting real-time inventory listener...");
            onSnapshot(collection(db, "inventory"), (snapshot) => {
                console.log("Inventory snapshot received, size:", snapshot.size);
                lastSnapshot = snapshot;
                renderAll(snapshot);
            }, (error) => {
                console.error("Inventory Snapshot Error:", error);
            });

            // Stats counts for dashboard
            const statPendingApps = document.getElementById('statPendingApps');
            if (statPendingApps) {
                const qApps = query(collection(db, "applicants"), where("status", "==", "pending"));
                onSnapshot(qApps, (snapshot) => {
                    statPendingApps.innerText = snapshot.size;
                });
            }

            const recentUploadsList = document.getElementById('recentUploadsList');
            if (recentUploadsList) {
                const qRecent = query(collection(db, "inventory"), orderBy("lastUpdated", "desc"), limit(3));
                onSnapshot(qRecent, (snapshot) => {
                    renderRecentUploads(snapshot);
                });
            }
        } catch (err) {
            console.error("Error in inventory init:", err);
        }
    });
};

function renderAll(snapshot) {
    const inventoryTableBody = document.querySelector('.inventory-table tbody');
    const dashboardInventoryBody = document.getElementById('dashboardInventoryBody');
    const materialsList = document.querySelector('.items-list');

    if (inventoryTableBody) renderPhysicalInventory(snapshot, inventoryTableBody);
    if (dashboardInventoryBody) renderDashboardInventory(snapshot, dashboardInventoryBody);
    if (materialsList) renderScrapMaterials(snapshot, materialsList);
    
    updateDashboardStats(snapshot);
}

function renderPhysicalInventory(snapshot, tbody) {
    tbody.innerHTML = '';
    let itemsFound = false;

    snapshot.forEach(docSnap => {
        const data = docSnap.data();
        const id = docSnap.id;

        if (currentCategoryFilter !== 'All' && data.category !== currentCategoryFilter) return;

        itemsFound = true;
        const tr = document.createElement('tr');
        tr.dataset.id = id;

        if (editingRowId === id) {
            tr.innerHTML = `
                <td><input type="text" value="${escapeHtml(data.itemName)}" class="edit-input" id="edit-name-${escapeHtml(id)}"></td>
                <td>
                    <select class="edit-input" id="edit-category-${escapeHtml(id)}">
                        <option value="Wood" ${data.category === 'Wood' ? 'selected' : ''}>Wood</option>
                        <option value="Plastic" ${data.category === 'Plastic' ? 'selected' : ''}>Plastic</option>
                        <option value="Metal" ${data.category === 'Metal' ? 'selected' : ''}>Metal</option>
                        <option value="Paper" ${data.category === 'Paper' ? 'selected' : ''}>Paper</option>
                        <option value="Fiber" ${data.category === 'Fiber' ? 'selected' : ''}>Fiber</option>
                    </select>
                </td>
                <td><input type="number" value="${data.quantity}" class="edit-input" id="edit-qty-${escapeHtml(id)}"></td>
                <td>
                    <select class="edit-input" id="edit-condition-${escapeHtml(id)}">
                        <option value="Good" ${data.condition === 'Good' ? 'selected' : ''}>Good</option>
                        <option value="Fair" ${data.condition === 'Fair' ? 'selected' : ''}>Fair</option>
                        <option value="Poor" ${data.condition === 'Poor' ? 'selected' : ''}>Poor</option>
                    </select>
                </td>
                <td style="color: #718096; font-size: 13px;">${data.lastUpdated ? new Date(data.lastUpdated.seconds * 1000).toLocaleDateString() : 'N/A'}</td>
                <td class="action-cell">
                    <button class="btn-save" onclick="saveEdit('${escapeHtml(id)}')">Save</button>
                    <button class="btn-cancel" onclick="cancelEdit()">Cancel</button>
                </td>
            `;
        } else {
            tr.innerHTML = `
                <td><strong>${escapeHtml(data.itemName)}</strong></td>
                <td><span class="badge-category">${escapeHtml(data.category)}</span></td>
                <td>${escapeHtml(String(data.quantity || 0))} ${escapeHtml(data.unit || 'kg')}</td>
                <td>${escapeHtml(data.condition || 'Good')}</td>
                <td style="color: #718096; font-size: 13px;">${data.lastUpdated ? new Date(data.lastUpdated.seconds * 1000).toLocaleDateString() : 'N/A'}</td>
                <td class="action-cell">
                    <button class="btn-edit-inline" onclick="startEdit('${escapeHtml(id)}')">Edit</button>
                </td>
            `;
        }
        tbody.appendChild(tr);
    });

    if (!itemsFound) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="6" style="text-align: center; padding: 40px; color: #718096; font-style: italic;">No items found in ${currentCategoryFilter} category</td>`;
        tbody.appendChild(tr);
    }
}

function renderDashboardInventory(snapshot, tbody) {
    tbody.innerHTML = '';
    snapshot.forEach(docSnap => {
        const data = docSnap.data();
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(data.itemName)}</strong></td>
            <td><span class="badge-category">${escapeHtml(data.category)}</span></td>
            <td>${escapeHtml(String(data.quantity || 0))} ${escapeHtml(data.unit || 'kg')}</td>
            <td><span class="badge available">Active</span></td>
            <td style="font-size: 12px; color: #718096;">${data.lastUpdated ? new Date(data.lastUpdated.seconds * 1000).toLocaleDateString() : 'N/A'}</td>
        `;
        tbody.appendChild(tr);
    });
}

function updateDashboardStats(snapshot) {
    const statTotalItems = document.getElementById('statTotalItems');
    const statTotalCategories = document.getElementById('statTotalCategories');
    const statTotalActive = document.getElementById('statTotalActive');
    const statLowStock = document.getElementById('statLowStock');

    let totalItems = snapshot.size;
    let activeCount = 0;
    let totalWeight = 0;
    const uniqueCategories = new Set();
    const categoryCounts = {};

    snapshot.forEach(doc => {
        const data = doc.data();
        const kg = data.quantity || 0;
        const cat = data.category || 'Other';
        const status = data.status || 'active'; // Default to active if missing

        totalWeight += kg;
        uniqueCategories.add(cat);
        if (status.toLowerCase() === 'active') activeCount++;
        
        categoryCounts[cat] = (categoryCounts[cat] || 0) + kg;
    });

    if (statTotalItems) statTotalItems.innerText = totalItems;
    if (statTotalCategories) statTotalCategories.innerText = uniqueCategories.size;
    if (statTotalActive) statTotalActive.innerText = activeCount;
    
    // Fallback for old IDs if they still exist in HTML
    if (statLowStock) {
        let lowStockCount = 0;
        snapshot.forEach(doc => { if ((doc.data().quantity || 0) < 50) lowStockCount++; });
        statLowStock.innerText = lowStockCount;
    }

    const breakdown = document.getElementById('categoryBreakdown');
    if (breakdown) {
        breakdown.innerHTML = '<h3>Category Breakdown</h3>';
        for (const [cat, val] of Object.entries(categoryCounts)) {
            const percentage = totalWeight > 0 ? Math.round((val / totalWeight) * 100) : 0;
            const item = document.createElement('div');
            item.className = 'chart-item';
            item.style.gridTemplateColumns = '110px 1fr 80px';
            item.innerHTML = `
                <label>${cat}</label>
                <div class="progress-bar">
                    <div class="progress" style="width: ${percentage}%;"></div>
                </div>
                <span class="amount">${val} kg</span>
            `;
            breakdown.appendChild(item);
        }
    }
}

function renderRecentUploads(snapshot) {
    const recentUploadsList = document.getElementById('recentUploadsList');
    if (!recentUploadsList) return;
    recentUploadsList.innerHTML = '';

    snapshot.forEach(doc => {
        const data = doc.data();
        const item = document.createElement('div');
        item.className = 'recent-item';
        item.innerHTML = `
            <div>
                <h4>${escapeHtml(data.itemName)}</h4>
                <p>${escapeHtml(data.category)} ${data.unit ? '• Unit: ' + escapeHtml(data.unit) : ''}</p>
            </div>
            <div>
                <p class="amount">${escapeHtml(String(data.quantity || 0))} ${escapeHtml(data.unit || 'kg')}</p>
                <span class="badge available">Updated</span>
            </div>
        `;
        recentUploadsList.appendChild(item);
    });
}

function renderScrapMaterials(snapshot, list) {
    list.innerHTML = '';
    snapshot.forEach(docSnap => {
        const data = docSnap.data();
        const id = docSnap.id;
        const card = document.createElement('div');
        card.className = 'item-card';
        card.innerHTML = `
            <div class="item-details">
                <h4>${escapeHtml(data.itemName)}</h4>
                <p>${escapeHtml(data.category)} ${data.unit ? '• Unit: ' + escapeHtml(data.unit) : ''}</p>
            </div>
            <div class="item-stats">
                <p class="quantity">${escapeHtml(String(data.quantity || 0))} ${escapeHtml(data.unit || 'kg')}</p>
            </div>
        `;
        card.onclick = () => showAdjustmentPanel(data, id);
        list.appendChild(card);
    });
}

function showAdjustmentPanel(data, id) {
    const adjustPanel = document.querySelector('.adjust-placeholder');
    if (!adjustPanel) return;

    adjustPanel.innerHTML = `
        <div style="width: 100%; text-align: left;">
            <h4 style="margin-bottom: 15px;">${escapeHtml(data.itemName)}</h4>
            <div class="adjustment-form">
                <div style="margin-bottom: 15px;">
                    <label>Current Quantity</label>
                    <input type="text" value="${escapeHtml(String(data.quantity || 0))} ${escapeHtml(data.unit || 'kg')}" readonly style="width: 100%; padding: 10px; border: 1px solid #e0e0e0; border-radius: 6px; background: #f9f9f9;">
                </div>
                <div style="margin-bottom: 15px;">
                    <label>Adjustment (+/-)</label>
                    <input type="number" id="adjustQty" placeholder="Enter quantity change" style="width: 100%; padding: 10px; border: 1px solid #e0e0e0; border-radius: 6px;">
                </div>
                <button id="btnUpdateStock" style="width: 100%; padding: 12px; background: #166734; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Update Stock</button>
            </div>
        </div>
    `;

    document.getElementById('btnUpdateStock').onclick = async () => {
        const change = parseFloat(document.getElementById('adjustQty').value);
        if (isNaN(change)) return showToast("Please enter a valid number", "warning");
        
        const confirmed = await showConfirm(
            'Update Stock',
            `Are you sure you want to adjust stock by ${change >= 0 ? '+' : ''}${change} kg?`,
            'Update',
            'primary'
        );
        if (!confirmed) return;

        try {
            await updateDoc(doc(db, "inventory", id), {
                quantity: (data.quantity || 0) + change,
                lastUpdated: serverTimestamp()
            });
            showToast("Stock updated!", "success");
        } catch (e) {
            showToast("Error updating stock: " + e.message, "error");
        }
    };
}

// Global functions for inline editing
window.startEdit = (id) => {
    editingRowId = id;
    if (lastSnapshot) renderAll(lastSnapshot);
};

window.cancelEdit = () => {
    editingRowId = null;
    if (lastSnapshot) renderAll(lastSnapshot);
};

window.saveEdit = async (id) => {
    const newName = document.getElementById(`edit-name-${id}`).value;
    const newCategory = document.getElementById(`edit-category-${id}`).value;
    const newQty = parseFloat(document.getElementById(`edit-qty-${id}`).value);
    const newCondition = document.getElementById(`edit-condition-${id}`).value;

    if (!newName || isNaN(newQty)) return showToast("Please fill all fields correctly.", "warning");

    try {
        await updateDoc(doc(db, "inventory", id), {
            itemName: newName,
            category: newCategory,
            quantity: newQty,
            condition: newCondition,
            lastUpdated: serverTimestamp()
        });
        editingRowId = null;
        showToast("Inventory updated successfully!", "success");
    } catch (e) {
        showToast("Error updating inventory: " + e.message, "error");
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // STEP 5: Call functions AFTER page loads
    window.loadInventory?.();
    
    // CNN UI Logic
    const cnnFileInput = document.getElementById('cnnFileInput');
    const btnClassify = document.getElementById('btnClassify');
    const cnnPreviewContainer = document.getElementById('cnnPreviewContainer');
    const cnnPreviewImage = document.getElementById('cnnPreviewImage');
    const btnRemoveImage = document.getElementById('btnRemoveImage');
    const cnnResultContainer = document.getElementById('cnnResultContainer');

    if (cnnFileInput) {
        cnnFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    cnnPreviewImage.src = event.target.result;
                    cnnPreviewContainer.style.display = 'block';
                    if (btnClassify) btnClassify.disabled = false;
                };
                reader.readAsDataURL(file);
            }
        });
    }

    if (btnRemoveImage) {
        btnRemoveImage.addEventListener('click', () => {
            if (cnnFileInput) cnnFileInput.value = '';
            if (cnnPreviewImage) cnnPreviewImage.src = '';
            if (cnnPreviewContainer) cnnPreviewContainer.style.display = 'none';
            if (cnnResultContainer) cnnResultContainer.style.display = 'none';
            if (btnClassify) btnClassify.disabled = true;
        });
    }

    // Save New Item Logic
    const btnSaveNewItem = document.getElementById('btnSaveNewItem');
    if (btnSaveNewItem) {
        btnSaveNewItem.addEventListener('click', async () => {
            const name = document.getElementById('newItemName').value.trim();
            const category = document.getElementById('newItemCategory').value;
            const qty = parseFloat(document.getElementById('newItemQty').value);
            const condition = document.getElementById('newItemCondition').value;

            if (!name || isNaN(qty)) return showToast("Please fill in Name and Quantity.", "warning");

            try {
                await setDoc(doc(collection(db, "inventory")), {
                    itemName: name,
                    category: category,
                    quantity: qty,
                    unit: "kg",
                    condition: condition,
                    dateAdded: serverTimestamp(),
                    lastUpdated: serverTimestamp()
                });
                showToast("Item added successfully!", "success");
                document.getElementById('newItemName').value = '';
                document.getElementById('newItemQty').value = '';
            } catch (error) {
                console.error("Save Error:", error);
                showToast("Error saving item: " + error.message, "error");
            }
        });
    }

    // Filter Buttons
    const filterButtons = document.querySelectorAll('.filter-btn');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            currentCategoryFilter = btn.dataset.category;
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (lastSnapshot) renderAll(lastSnapshot);
        });
    });
});
