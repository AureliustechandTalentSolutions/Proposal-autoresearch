// Chart.js configuration utilities for Aurelius Autoresearch Agent
// Chart.js is loaded from CDN in index.html

function createScoreChart(canvasId) {
    const ctx = document.getElementById(canvasId);
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Score', data: [], borderColor: '#c9a227', fill: true, tension: 0.3 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { min: 0, max: 100, grid: { color: '#2a2a4a' } },
                x: { grid: { color: '#2a2a4a' } }
            }
        }
    });
}
