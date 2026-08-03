# RC Mech

RC Mech is the shared language for an owner's collection of radio-controlled cars and the work needed to keep them ready to drive.

## People and collection

**Owner**:
The person responsible for a garage and its cars.
_Avoid_: User, customer, account

**Car**:
A radio-controlled vehicle tracked as a distinct thing in an owner's garage.
_Avoid_: Build, chassis

**Component**:
A physical part installed on, or kept for, a car, such as a motor, battery, servo, or tire.
_Avoid_: Part, equipment

**Component slot**:
The named position and role on a car that can hold one component at a time, such as "motor" or "steering servo".
_Avoid_: Mount, location

## Driving and maintenance

**Drive session**:
A recorded occasion on which an owner drives a car, including the conditions and usage that matter for maintenance.
_Avoid_: Run, outing, trip

**Maintenance plan**:
A recurring care rule for an installed component, expressed in calendar time, drive sessions, or both.
_Avoid_: Reminder, task, schedule

**Service record**:
An account of maintenance performed on a car or component, including what was done and when.
_Avoid_: Work order, repair, note

**Baseline**:
The point from which a maintenance plan measures elapsed time or drive-session usage.
_Avoid_: Reset date, starting point

**Archived**:
A retained car or record that is no longer part of the owner's active garage or workflow.
_Avoid_: Deleted, removed
