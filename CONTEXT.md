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

**Setup change**:
A new setup copied from the current setup and modified to represent intentional tuning work while preserving the previous setup in history.
_Avoid_: Edit setup, overwrite setup

**Setup correction**:
An explicit repair to a recording mistake in an existing setup. It corrects history rather than representing new tuning work.
_Avoid_: Setup change, new setup

**Changes from previous**:
The recorded field differences between a setup and the setup it was copied from.
_Avoid_: Diff, delta

**Ride height**:
The setup's single chassis-clearance value, such as 12 mm or 14 mm. RC Mech does not split ride height into front and rear values or model a raked ride height.
_Avoid_: Front ride height, rear ride height, rake

**Rear toe setting**:
The pair of physical pill positions recorded by the current setup for a car's rear C and D suspension blocks. RC Mech preserves those positions and does not derive a numeric toe angle.
_Avoid_: Rear toe value, rear toe angle

**Pill position**:
The vertical and lateral placement of an adjustment pill within a suspension block, such as up and in or center and in.
_Avoid_: Toe number, pill value

**Gear differential setting**:
The setup-sheet values that describe an oil-filled gear differential. A 2WD setting includes differential oil and height; a 4WD setting identifies each applicable front, center, or rear differential and its oil.
_Avoid_: Diff value, universal diff oil

**Center slipper**:
A 4WD center-drive configuration that can be decoupled and therefore has no center differential-oil value.
_Avoid_: Center differential, missing center oil

**Shock package**:
The front and rear spring and shock-oil choices recorded together in a setup.
_Avoid_: Suspension package, shock configuration

**Drive session**:
A recorded occasion on which a user drives a car, including the conditions and usage that matter for maintenance.
_Avoid_: Run, outing, trip

**Voice note**:
A spoken trackside observation captured for a car and optionally associated with a drive session. It retains the original private audio and its transcript until the user deletes the note.
_Avoid_: Voice command, prompt

**Voice transcript**:
The textual transcription of what the user said in a voice note. It is not setup guidance or a tuning recommendation.
_Avoid_: Translation, advice, recommendation

**Voice draft**:
A reviewable set of proposed garage records extracted only from facts the user explicitly stated in a voice note. It does not alter garage history until the user confirms it.
_Avoid_: Setup guidance, automatic update

**Trackside observation**:
A recorded statement about car behavior or driving conditions that does not claim a setup change was made.
_Avoid_: Setup recommendation, inferred change

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
