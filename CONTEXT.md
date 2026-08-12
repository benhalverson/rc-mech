# Chassis Notes

Chassis Notes is the shared language for an owner's collection of radio-controlled cars and the work needed to keep them ready to drive.

## People and collection

**Chassis Notes**:
The public product name for the private field notebook. `rc-mech` names internal repositories, deployments, resources, storage, and compatibility-sensitive identifiers only.
_Avoid_: RC Mech as a product name

**Racer**:
A person who prepares, tunes, drives, and maintains radio-controlled cars for competitive track use and wants repeatable records between drive sessions. Chassis Notes serves Racers first; casual driving use is secondary.
_Avoid_: Customer, generic hobbyist

**Owner**:
The creator and operator of Chassis Notes. The Owner is the only person with
application-level ownership; this role is not granted to invited users.

**User**:
A person who registers through an invite and has one isolated garage and its
own settings. Users do not share garage records by default and are not Owners.
_Avoid_: Customer, account

**Registration**:
The act of establishing a user's access to Chassis Notes through a verified email
address and a valid invite code. Registration creates access to that user's
isolated garage.
_Avoid_: Account creation

**Invite code**:
A private value provided by the Chassis Notes operator that permits one prospective
user to begin registration. Each code is single-use; each registered User may
receive five codes to pass on. The User may choose each code's
human-shareable text, provided it is unique.
_Avoid_: Coupon, access token

**Garage**:
A User's isolated private collection of cars and their attached histories.
_Avoid_: Workspace, inventory

**Car**:
A radio-controlled vehicle tracked as a distinct thing in a user's garage.
_Avoid_: Build, chassis

**Subject car**:
The visual identity of one existing Garage Car selected within a Race window whose observed driving belongs to a Driving analysis. Other cars visible in the Track view are context and are not analyzed by that analysis.
_Avoid_: Target, tracked object, all cars

**Tracking gap**:
A span of a Race window where the Subject car's identity is uncertain. Motion across the gap is not interpolated, and any overlapping corner traversal is ineligible to become a Corner pass.
_Avoid_: Missing frames, estimated path, tracking failure

**Re-identification**:
The User's confirmation of the Subject car by drawing a new box at the first clear frame after a Tracking gap. Tracking resumes from that frame without filling the gap.
_Avoid_: Automatic reacquisition, identity guess, interpolation

**Subject observation**:
A timestamped, confidence-bearing observation of the Subject car's visible position in the Track view. It is model evidence used by deterministic gate timing, not a Corner pass or ranking by itself.
_Avoid_: Prediction, racing line, score

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
The setup's single chassis-clearance value, such as 12 mm or 14 mm. Chassis Notes does not split ride height into front and rear values or model a raked ride height.
_Avoid_: Front ride height, rear ride height, rake

**Rear toe setting**:
The pair of physical pill positions recorded by the current setup for a car's rear C and D suspension blocks. Chassis Notes preserves those positions and does not derive a numeric toe angle.
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
A recorded occasion on which a User drives a Car, including the conditions and usage that matter for maintenance. A Driving analysis belongs to the Drive session whose race it interprets.
_Avoid_: Run, outing, trip

**Race recording**:
A private video file uploaded by a User for one Drive session and stored in Driving-analysis media storage. It may contain footage before or after the race of interest, so the User still selects the exact Race window to analyze.
_Avoid_: External video, live feed, public video

**Race window**:
The User-selected start and end timestamps for one race within a Race recording. Only this interval belongs to its Driving analysis.
_Avoid_: Full video, trim, processing range

**Track view**:
The bottom two-thirds of a supported Race recording, where the authoritative static-camera view remains fixed for the entire Race window. Other camera panels, overlays, and broadcast graphics are outside the Driving analysis.
_Avoid_: User-selected crop, camera feed, composite view

**Track layout**:
The physical arrangement and direction of the racing surface visible in the Track view. One venue may use different Track layouts over time.
_Avoid_: Track, venue, camera view

**Track map**:
A reusable description of one Track layout aligned to the supported source's invariant Track view and identifying each corner with an entry Corner gate, exit Corner gate, and Corner view. Only the Owner creates, edits, and approves Track maps; Users select an approved map for a Driving analysis.
_Avoid_: Auto-detected layout, racing line, venue map

**Track-map version**:
An immutable approved revision of a Track map. Each Driving analysis remains pinned to the version used to measure its Corner passes, even after the Owner approves later revisions.
_Avoid_: Current map, mutable map, overwritten map

**Corner gate**:
A directed line drawn across the racing surface on a Track map. Each corner has one entry gate and one exit gate, and the Subject car's center crossing them bounds a Corner pass.
_Avoid_: Checkpoint, corner boundary, timing loop

**Corner view**:
The fixed rectangular region of a Track map used to spatially crop every Corner clip for one corner. It shows the corner at a useful review scale while excluding unrelated parts of the Track view.
_Avoid_: Camera view, dynamic crop, tracking box

**Corner pass**:
One fully observed traversal of a defined corner by the Subject car, measured from its center crossing the entry Corner gate to its center crossing the exit Corner gate. The car's identity must remain unambiguous throughout the gate-to-gate interval.
_Avoid_: Lap, clip, turn

**Corner clip**:
A short reviewable video excerpt spatially cropped to the corner's Corner view, beginning 0.5 seconds before the entry-gate crossing and ending 0.5 seconds after the exit-gate crossing. Every eligible Corner pass has a clip; the clip for the Best corner pass is labeled rather than kept as the only evidence.
_Avoid_: Highlight reel, source video, best-only clip

**Best corner pass**:
The eligible Corner pass with the shortest observed traversal time for one corner during a Driving analysis. A traversal with uncertain Subject-car identity is ineligible; the Best corner pass is measured evidence, not a generated or hypothetical racing line.
_Avoid_: Ideal line, predicted line, recommended line

**Driving analysis**:
A post-drive interpretation attached to one Drive session and its Subject car, using one Race window to divide the track into meaningful sections and compare that car's corner entry and exit from evidence visible in that interval.
_Avoid_: Racing line prediction, autonomous coaching, video processing job

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
A recorded statement about car behavior or driving conditions that does not claim a setup change was made or caused the observed behavior.
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

## Offline use

**Offline session**:
A temporary period after a successful online sign-in and synchronization when a User continues using a previously synchronized garage while trackside connectivity is unavailable.
_Avoid_: Guest mode, anonymous mode

**Offline ready**:
The device state reached after Chassis Notes has synchronized the structured garage records and media metadata required for an Offline session.
_Avoid_: Downloaded, backed up

**Pending sync**:
Garage work retained on the User's device during an Offline session but not yet acknowledged by the Chassis Notes service. Pending sync is not presented as remotely completed work.
_Avoid_: Saved, completed, failed

**Needs attention**:
Garage work retained on the User's device after it cannot synchronize automatically and requires review or correction. It is not discarded and does not prevent unrelated work from synchronizing.
_Avoid_: Failed, lost, deleted

**Sync conflict**:
A Pending sync action whose remote target changed incompatibly after the device last synchronized. Chassis Notes retains both versions until the User chooses the correct result.
_Avoid_: Last write wins, sync failure

**Offline media**:
A photo or original voice-note recording retained on the current device so it remains available during an Offline session. Existing media becomes Offline media when viewed or explicitly kept offline; new captures remain local until synchronized.
_Avoid_: Backup, downloaded file
