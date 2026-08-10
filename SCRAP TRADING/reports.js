import { db } from './firebase.js';
import { collection, onSnapshot, query, orderBy, limit, getDocs, where, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Chart instances
let categoryChart = null;
let conditionChart = null;

const LOW_STOCK_THRESHOLD = 5;

document.addEventListener('DOMContentLoaded', () => {
    initReports();
    initPdfExport();
});

function initReports() {
    const totalItemsEl = document.getElementById('totalItems');
    const availableItemsEl = document.getElementById('availableItems');
    const processingItemsEl = document.getElementById('processingItems');
    const lowStockCountEl = document.getElementById('lowStockCount');
    const lowStockListEl = document.getElementById('lowStockList');
    const recentActivityListEl = document.getElementById('recentActivityList');
    const alertsListEl = document.getElementById('alertsList');

    // Real-time listener for all inventory items
    onSnapshot(collection(db, "inventory"), (snapshot) => {
        const items = [];
        snapshot.forEach(doc => {
            items.push({ id: doc.id, ...doc.data() });
        });

        updateSummary(items, totalItemsEl, availableItemsEl, processingItemsEl, lowStockCountEl);
        updateCharts(items);
        updateLowStockReport(items, lowStockListEl);
        updateAlerts(items, alertsListEl);
    });

    // Separate listener for recent activity (ordered by lastUpdated)
    const recentQuery = query(collection(db, "inventory"), orderBy("lastUpdated", "desc"), limit(10));
    onSnapshot(recentQuery, (snapshot) => {
        const recentItems = [];
        snapshot.forEach(doc => {
            recentItems.push({ id: doc.id, ...doc.data() });
        });
        updateRecentActivity(recentItems, recentActivityListEl);
    });
}

function updateSummary(items, totalEl, availableEl, processingEl, lowStockEl) {
    const total = items.length;
    let available = 0;
    let processing = 0;
    let lowStock = 0;

    items.forEach(item => {
        if (item.condition === 'Good') available++;
        if (item.condition === 'Processing') processing++;
        if (item.quantity < LOW_STOCK_THRESHOLD) lowStock++;
    });

    if (totalEl) totalEl.innerText = total;
    if (availableEl) availableEl.innerText = available;
    if (processingEl) processingEl.innerText = processing;
    if (lowStockEl) lowStockEl.innerText = lowStock;
}

function updateCharts(items) {
    // Category Breakdown
    const categories = {};
    const conditions = { 'Good': 0, 'Fair': 0, 'Poor': 0, 'Processing': 0 };

    items.forEach(item => {
        const cat = item.category || 'Uncategorized';
        categories[cat] = (categories[cat] || 0) + 1;

        const cond = item.condition || 'Good';
        conditions[cond] = (conditions[cond] || 0) + 1;
    });

    renderCategoryChart(categories);
    renderConditionChart(conditions);
}

function renderCategoryChart(data) {
    const ctx = document.getElementById('categoryChart');
    if (!ctx) return;

    if (categoryChart) {
        categoryChart.destroy();
    }

    categoryChart = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: Object.keys(data),
            datasets: [{
                data: Object.values(data),
                backgroundColor: ['#4A90E2', '#2ECC71', '#FFB74D', '#9B59B6', '#E74C3C', '#F1C40F'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom' }
            }
        }
    });
}

function renderConditionChart(data) {
    const ctx = document.getElementById('conditionChart');
    if (!ctx) return;

    if (conditionChart) {
        conditionChart.destroy();
    }

    conditionChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(data),
            datasets: [{
                label: 'Number of Items',
                data: Object.values(data),
                backgroundColor: '#166734',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 } }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function updateLowStockReport(items, container) {
    if (!container) return;

    const lowStockItems = items.filter(item => item.quantity < LOW_STOCK_THRESHOLD);
    
    if (lowStockItems.length === 0) {
        container.innerHTML = '<p style="color: #718096; font-size: 14px;">No items currently low on stock.</p>';
        return;
    }

    container.innerHTML = lowStockItems.map(item => `
        <div class="low-stock-item">
            <div>
                <strong style="font-size: 14px;">${item.itemName}</strong>
                <p style="margin: 2px 0 0 0; font-size: 12px; color: #718096;">Category: ${item.category}</p>
            </div>
            <div style="text-align: right;">
                <span style="color: #e53e3e; font-weight: 700;">${item.quantity} ${item.unit || 'kg'}</span>
                <p style="margin: 2px 0 0 0; font-size: 11px; color: #a0aec0;">Threshold: ${LOW_STOCK_THRESHOLD}</p>
            </div>
        </div>
    `).join('');
}

function updateRecentActivity(items, container) {
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = '<p style="color: #718096; font-size: 14px;">No recent activity.</p>';
        return;
    }

    container.innerHTML = items.map(item => {
        const date = item.lastUpdated ? new Date(item.lastUpdated.seconds * 1000).toLocaleString() : 'Just now';
        return `
            <div class="activity-item">
                <p class="activity-title">${item.itemName} was updated</p>
                <p class="activity-meta">New Quantity: ${item.quantity} ${item.unit || 'kg'} | ${date}</p>
            </div>
        `;
    }).join('');
}

function updateAlerts(items, container) {
    if (!container) return;

    const alerts = [];

    items.forEach(item => {
        if (item.quantity < LOW_STOCK_THRESHOLD) {
            alerts.push({
                type: 'critical',
                message: `Low Stock: ${item.itemName} is at ${item.quantity} ${item.unit || 'kg'}.`
            });
        }
        if (item.condition === 'Poor') {
            alerts.push({
                type: 'warning',
                message: `Poor Condition: ${item.itemName} needs attention.`
            });
        }
    });

    if (alerts.length === 0) {
        container.innerHTML = '<p style="color: #718096; font-size: 14px;">All systems normal. No alerts.</p>';
        return;
    }

    container.innerHTML = alerts.map(alert => `
        <div class="alert-critical">
            ⚠️ ${alert.message}
        </div>
    `).join('');
}

function initPdfExport() {
    const exportSection = document.getElementById('reportExportSection');
    const rangeSelect = document.getElementById('reportRange');
    const downloadBtn = document.getElementById('downloadReportBtn');
    const statusEl = document.getElementById('reportStatus');

    if (!exportSection || !rangeSelect || !downloadBtn) return;

    const userCtx = getUserContext();
    const role = (userCtx.role || '').toLowerCase();
    const roleKnown = !!role && role !== 'unknown';
    const allowed = role === 'owner' || role === 'secretary';
    if (roleKnown && !allowed) {
        exportSection.style.display = 'none';
        return;
    }

    downloadBtn.addEventListener('click', async () => {
        const latestRole = (getUserContext().role || '').toLowerCase();
        const latestAllowed = latestRole === 'owner' || latestRole === 'secretary';
        if (latestRole && latestRole !== 'unknown' && !latestAllowed) {
            exportSection.style.display = 'none';
            return;
        }
        const range = rangeSelect.value || 'all';
        downloadBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Generating PDF...';

        try {
            const reportData = await fetchReportData(range);
            generatePdf(reportData);
            if (statusEl) statusEl.textContent = '';
        } catch (e) {
            console.error('Report export error:', e);
            if (statusEl) statusEl.textContent = 'Failed to generate report. Check console.';
            alert('Failed to generate report: ' + (e?.message || e));
        } finally {
            downloadBtn.disabled = false;
        }
    });
}

function getUserContext() {
    try {
        const stored = sessionStorage.getItem('currentUser');
        if (stored) return JSON.parse(stored);
    } catch (e) {
        console.warn('Could not parse session user:', e);
    }
    return { role: 'Unknown', fullName: 'User' };
}

function getRangeStart(range) {
    const now = new Date();
    if (range === 'today') {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        return d;
    }
    if (range === 'weekly') {
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    if (range === 'monthly') {
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    return null;
}

function coerceDate(ts) {
    if (!ts) return null;
    if (ts instanceof Date) return ts;
    if (typeof ts === 'number') return new Date(ts);
    if (ts.seconds) return new Date(ts.seconds * 1000);
    if (ts.toDate) return ts.toDate();
    return null;
}

async function fetchReportData(range) {
    const userCtx = getUserContext();
    const start = getRangeStart(range);
    const startTs = start ? Timestamp.fromDate(start) : null;

    let inventoryDocs = [];
    try {
        const invBase = collection(db, 'inventory');
        const invQuery = startTs
            ? query(invBase, where('lastUpdated', '>=', startTs), orderBy('lastUpdated', 'desc'))
            : query(invBase, orderBy('lastUpdated', 'desc'));
        const invSnap = await getDocs(invQuery);
        inventoryDocs = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('Inventory query failed, falling back to client filtering:', e);
        const invSnap = await getDocs(collection(db, 'inventory'));
        inventoryDocs = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (start) {
            inventoryDocs = inventoryDocs.filter(item => {
                const d = coerceDate(item.lastUpdated);
                return d ? d >= start : false;
            });
            inventoryDocs.sort((a, b) => (coerceDate(b.lastUpdated)?.getTime() || 0) - (coerceDate(a.lastUpdated)?.getTime() || 0));
        }
    }

    let transactionDocs = [];
    try {
        const txBase = collection(db, 'transactions');
        const txQuery = startTs
            ? query(txBase, where('uploadedAt', '>=', startTs), orderBy('uploadedAt', 'desc'), limit(25))
            : query(txBase, orderBy('uploadedAt', 'desc'), limit(25));
        const txSnap = await getDocs(txQuery);
        transactionDocs = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('Transactions query failed (optional section will be empty):', e);
        transactionDocs = [];
    }

    const summary = computeInventorySummary(inventoryDocs);
    const recentItems = inventoryDocs.slice(0, 10);
    const recentTransactions = transactionDocs.slice(0, 10);

    return {
        generatedAt: new Date(),
        generatedByRole: userCtx.role || 'Unknown',
        generatedByName: userCtx.fullName || userCtx.name || 'User',
        range,
        summary,
        recentItems,
        recentTransactions
    };
}

function computeInventorySummary(items) {
    const categories = ['Metal', 'Plastic', 'Wood', 'Paper', 'Fiber'];
    const breakdown = {};
    categories.forEach(c => breakdown[c] = { count: 0, weight: 0 });
    breakdown.Other = { count: 0, weight: 0 };

    let totalWeight = 0;
    let goodCount = 0;
    let poorCount = 0;

    for (const item of items) {
        const rawWeight = item.weight !== undefined ? item.weight : item.quantity !== undefined ? item.quantity : 0;
        const weight = Number(rawWeight) || 0;
        totalWeight += weight;

        const cat = categories.includes(item.category) ? item.category : 'Other';
        breakdown[cat].count += 1;
        breakdown[cat].weight += weight;

        if (item.condition === 'Good') goodCount += 1;
        if (item.condition === 'Poor') poorCount += 1;
    }

    return {
        totalItems: items.length,
        totalWeightKg: totalWeight,
        categoryBreakdown: breakdown,
        goodCount,
        poorCount
    };
}

function formatRangeLabel(range) {
    if (range === 'today') return 'Today';
    if (range === 'weekly') return 'Weekly';
    if (range === 'monthly') return 'Monthly';
    return 'All Time';
}

function formatDateTime(dt) {
    return dt.toLocaleString('en-PH', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function generatePdf(report) {
    const jspdf = window.jspdf;
    const jsPDF = jspdf?.jsPDF;
    if (!jsPDF) throw new Error('jsPDF not loaded');

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();

    const title = 'PM2V Scrap Inventory Report';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(title, pageWidth / 2, 48, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Generated: ${formatDateTime(report.generatedAt)}`, 40, 70);
    doc.text(`Generated by: ${report.generatedByRole}`, 40, 86);
    doc.text(`Range: ${formatRangeLabel(report.range)}`, 40, 102);

    let cursorY = 126;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('1) Inventory Summary', 40, cursorY);
    cursorY += 16;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Total items: ${report.summary.totalItems}`, 40, cursorY);
    cursorY += 14;
    doc.text(`Total weight (kg): ${report.summary.totalWeightKg.toFixed(2)}`, 40, cursorY);
    cursorY += 18;

    const categoryRows = Object.entries(report.summary.categoryBreakdown)
        .filter(([k]) => k !== 'Other' || report.summary.categoryBreakdown.Other.count > 0)
        .map(([category, v]) => [category, String(v.count), v.weight.toFixed(2)]);

    if (typeof doc.autoTable === 'function') {
        doc.autoTable({
            startY: cursorY,
            head: [['Category', 'Items', 'Total Weight (kg)']],
            body: categoryRows,
            styles: { fontSize: 9 },
            headStyles: { fillColor: [22, 103, 52] }
        });
        cursorY = doc.lastAutoTable.finalY + 18;
    } else {
        doc.text('Category breakdown:', 40, cursorY);
        cursorY += 14;
        categoryRows.forEach(r => {
            doc.text(`${r[0]}: ${r[1]} items, ${r[2]} kg`, 40, cursorY);
            cursorY += 12;
        });
        cursorY += 10;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('2) Condition Summary', 40, cursorY);
    cursorY += 16;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Good items: ${report.summary.goodCount}`, 40, cursorY);
    cursorY += 14;
    doc.text(`Poor items: ${report.summary.poorCount}`, 40, cursorY);
    cursorY += 18;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('3) Recent Activity (Inventory)', 40, cursorY);
    cursorY += 10;

    const recentInvRows = report.recentItems.map(item => {
        const dt = coerceDate(item.lastUpdated);
        const dtStr = dt ? formatDateTime(dt) : 'N/A';
        const rawWeight = item.weight !== undefined ? item.weight : item.quantity !== undefined ? item.quantity : 0;
        const weight = Number(rawWeight) || 0;
        return [
            item.itemName || item.name || 'Unknown',
            item.category || 'N/A',
            weight.toFixed(2),
            item.condition || 'N/A',
            dtStr
        ];
    });

    if (typeof doc.autoTable === 'function') {
        doc.autoTable({
            startY: cursorY + 8,
            head: [['Item', 'Category', 'Weight (kg)', 'Condition', 'Last Updated']],
            body: recentInvRows,
            styles: { fontSize: 8 },
            headStyles: { fillColor: [45, 55, 72] }
        });
        cursorY = doc.lastAutoTable.finalY + 18;
    } else {
        cursorY += 14;
        recentInvRows.slice(0, 8).forEach(r => {
            doc.text(`${r[0]} | ${r[1]} | ${r[2]}kg | ${r[3]} | ${r[4]}`, 40, cursorY);
            cursorY += 12;
        });
        cursorY += 10;
    }

    if (report.recentTransactions && report.recentTransactions.length > 0) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text('4) Recent Transactions', 40, cursorY);
        cursorY += 10;

        const txRows = report.recentTransactions.map(tx => {
            const dt = coerceDate(tx.uploadedAt);
            const dtStr = dt ? formatDateTime(dt) : 'N/A';
            const qty = Number(tx.quantitySold) || 0;
            return [
                tx.itemName || 'N/A',
                tx.category || 'N/A',
                qty.toFixed(2),
                tx.buyerName || 'N/A',
                dtStr
            ];
        });

        if (typeof doc.autoTable === 'function') {
            doc.autoTable({
                startY: cursorY + 8,
                head: [['Item', 'Category', 'Qty Sold (kg)', 'Buyer', 'Date']],
                body: txRows,
                styles: { fontSize: 8 },
                headStyles: { fillColor: [22, 103, 52] }
            });
        } else {
            cursorY += 14;
            txRows.slice(0, 8).forEach(r => {
                doc.text(`${r[0]} | ${r[1]} | ${r[2]}kg | ${r[3]} | ${r[4]}`, 40, cursorY);
                cursorY += 12;
            });
        }
    }

    const datePart = report.generatedAt.toISOString().slice(0, 10);
    doc.save(`PM2V_Scrap_Inventory_Report_${formatRangeLabel(report.range).replace(' ', '_')}_${datePart}.pdf`);
}
