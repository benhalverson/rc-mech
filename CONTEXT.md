# RC Mech

RC Mech is the shared language for an owner's collection of radio-controlled cars and the work needed to keep them ready to drive.

## People and collection

**Owner**:
The creator and operator of RC Mech. The Owner is the only person with
application-level ownership; this role is not granted to invited users.

**User**:
A person who registers through an invite and has one isolated garage and its
own settings. Users do not share garage records by default and are not Owners.
_Avoid_: Customer, account

**Registration**:
The act of establishing a user's access to RC Mech through a verified email
address and a valid invite code. Registration creates access to that user's
isolated garage.
_Avoid_: Account creation

**Invite code**:
A private value provided by the RC Mech operator that permits one prospective
user to begin registration. Each code is single-use; each registered User may
receive five codes to pass on. The User may choose each code's
human-shareable text, provided it is unique.
_Avoid_: Coupon, access token

**Car**:
A radio-controlled vehicle tracked as a distinct thing in a user's garage.
_Avoid_: Build, chassis

**Component**:
A physical part installed on, or kept for, a car, such as a motor, battery, servo, or tire.
_Avoid_: Part, equipment

**Component slot**:
The named position and role on a car that can hold one component at a time, such as "motor" or "steering servo".
_Avoid_: Mount, location

## Driving and maintenance

**Setup**:
A recorded configuration of a car for a particular baseline, track, event, or driving condition. A setup contains the practical tuning values and context used to prepare or drive the car; it is not an inventory of every physical component.
_Avoid_: Build, component inventory, configuration

**Setup import**:
A setup created from an external setup-sheet link and reviewed by the user before it becomes part of the garage history.
_Avoid_: Automatic sync, scrape

**Current setup**:
The setup a user is using as the starting point for the next change. A car can have many setups, but only one needs to be current at a time.
_Avoid_: Permanent setup, active component list

**Drive session**:
A recorded occasion on which a user drives a car, including the conditions and usage that matter for maintenance.
_Avoid_: Run, outing, trip

**Consumable maintenance entry**:
A record of replacing or servicing something whose condition or life matters to driving, such as a front or rear tire set, shock fluid, or differential fluid.
_Avoid_: Component record, work order

**Tire set**:
The matched pair of tires installed on one axle, either front or rear. Tire maintenance is recorded per axle set and never as individual tires.
_Avoid_: Tire, wheel, individual tire

**Maintenance history**:
The chronological record of consumable maintenance entries for a car, including when tires or fluids were changed and any cost or service detail worth remembering.
_Avoid_: Maintenance schedule, due list

**Tire report**:
A summary of tire-set changes by axle, including last change, replacement frequency, and spend.
_Avoid_: Tire inventory, tire rotation

**Maintenance plan**:
A recurring care rule for an installed component, expressed in calendar time, drive sessions, or both. It remains part of the broader garage language, but it is not required for the setup-focused consumable history.
_Avoid_: Reminder, task, schedule

**Service record**:
An account of maintenance performed on a car or component, including what was done and when.
_Avoid_: Work order, repair, note

**Baseline**:
The point from which a maintenance plan measures elapsed time or drive-session usage.
_Avoid_: Reset date, starting point

**Archived**:
A retained car or record that is no longer part of the user's active garage or workflow.
_Avoid_: Deleted, removed
