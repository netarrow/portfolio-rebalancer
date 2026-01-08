import React, { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';

interface PortfolioPyramidProps {
    data: {
        name: string;
        value: number;
        color: string;
        breakdown?: { label: string; value: number }[];
    }[];
}

const PortfolioPyramid: React.FC<PortfolioPyramidProps> = ({ data }) => {
    // Data must be sorted for the pyramid look.
    // Largest at bottom means in a horizontal bar chart (where Category 0 is top),
    // we want Smallest -> Largest.
    const { chartData, categories, colors, sortedData } = useMemo(() => {
        // Sort: Smallest to Largest
        const sorted = [...data].sort((a, b) => a.value - b.value);

        return {
            chartData: [{
                name: 'Value',
                data: sorted.map(d => d.value)
            }],
            categories: sorted.map(d => d.name),
            colors: sorted.map(d => d.color),
            sortedData: sorted
        };
    }, [data]);

    const options: ApexOptions = useMemo(() => ({
        chart: {
            type: 'bar',
            height: 350,
            toolbar: { show: false },
            fontFamily: 'Inter, system-ui, sans-serif',
            background: 'transparent'
        },
        plotOptions: {
            bar: {
                borderRadius: 0,
                horizontal: true,
                barHeight: '80%',
                isFunnel: true,
                distributed: true, // Different color per bar
            }
        },
        colors: colors,
        dataLabels: {
            enabled: true,
            textAnchor: 'middle',
            style: {
                colors: ['#fff'],
                fontWeight: 600
            },
            formatter: function (val: number, opt) {
                const total = data.reduce((sum, d) => sum + d.value, 0);
                const percent = (val / total * 100).toFixed(1);
                return `${opt.w.globals.labels[opt.dataPointIndex]}: ${percent}%`;
            },
            dropShadow: { enabled: true }
        },
        xaxis: {
            categories: categories,
            labels: {
                show: false,
                formatter: (val) => {
                    return `€${Number(val).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`;
                },
                style: { colors: 'var(--text-secondary)' }
            },
            axisBorder: { show: false },
            axisTicks: { show: false }
        },
        yaxis: {
            show: false, // We show names in dataLabels or we can show them on axis
            // Let's hide y-axis labels and put names IN the bars for a cooler look?
            // Or keep them standard. Let's try standard first but maybe hide if names are long?
            // Actually, putting labels inside bars is "Premium". The formatter above puts "Name: %".
        },
        grid: {
            show: false,
            padding: { top: 0, bottom: 0, left: 10, right: 10 }
        },
        tooltip: {
            theme: 'dark',
            custom: function ({ dataPointIndex }: { dataPointIndex: number }) {
                // dataPointIndex corresponds to the index in the series array.
                const item = sortedData[dataPointIndex];

                if (!item) return '';

                const totalValue = item.value;
                const totalFormatted = totalValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                let breakdownHtml = '';
                if (item.breakdown && item.breakdown.length > 0) {
                    breakdownHtml = `
                        <div style="margin-top: 8px; border-top: 1px solid #444; padding-top: 4px;">
                            ${item.breakdown.map((b: { label: string; value: number }) => `
                                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 2px;">
                                    <span style="color: #ccc; margin-right: 12px;">${b.label}:</span>
                                    <span style="color: #fff;">€${b.value.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>
                                </div>
                            `).join('')}
                        </div>
                    `;
                }

                // Mimic standard ApexCharts dark tooltip style
                return `
                    <div class="arrow_box" style="padding: 10px; background: #1e1e1e; border: 1px solid #333;">
                        <div style="font-weight: 600; font-size: 13px; color: ${item.color}; margin-bottom: 2px;">
                            ${item.name}
                        </div>
                        <div style="font-size: 14px; font-weight: bold; color: #fff;">
                            €${totalFormatted}
                        </div>
                        ${breakdownHtml}
                    </div>
                `;
            }
        },
        legend: { show: false }
    }), [categories, colors, data, sortedData]);

    if (data.length === 0) return null;

    return (
        <div className="portfolio-pyramid-container" style={{ width: '100%', minHeight: '350px' }}>
            <ReactApexChart
                options={options}
                series={chartData}
                type="bar"
                height={350}
            />
        </div>
    );
};

export default PortfolioPyramid;
