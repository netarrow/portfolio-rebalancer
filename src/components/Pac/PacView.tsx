import React from 'react';
import PacPlanList from './PacPlanList';
import PacScheduleTable from './PacScheduleTable';

const PacView: React.FC = () => (
    <div className="pac-view-container">
        <PacPlanList />
        <PacScheduleTable />
    </div>
);

export default PacView;
