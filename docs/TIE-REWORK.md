Ties activate in real time. No Settings switch for ties.

1. Settings: remove the "Tie management" and "Tie-Breaker Engine"
   switches. Keep: Prize places (3 or 5, default 3) and Score One by
   One (default OFF).

2. Tie chip: show only when every active participant is scored or
   confirmed Absent, the event has not ended, and a tie exists.

3. End Event: blocked while any of these is true:
   - a tie touches a prize place
   - an absence request is pending
   - a tie round is open, closed but not published, or stale
   - a participant has neither full marks nor a confirmed absence
   Allowed: ties below prize places (shared), Not Ready tags.
   The server must enforce this too and return the list of blockers.

4. Tie methods: Countback, Olympic trim (warn under 5 judges),
   Re-compete, Shared places. "Recommended" is a tag only, never forced.
   Countback: recommended for 2 tied for 1st.
   Olympic: recommended only with 5+ judges.
   Re-compete: recommended for 3+ tied.
   Each confirmation shows what the method does, ranks before and after,
   and "This cannot be changed after you confirm." Once confirmed, the
   method is locked. Exception: a logged reopen with a written reason
   (3 to 300 characters) for a published round.

5. Shared 1st: needs organiser permission. Then ask each time: is the
   next place 2nd or 3rd?
   2nd: two firsts, one second, one third (continuous order).
   3rd: two firsts, no second, one third (standard order).
   Show the result and ask the organiser to confirm.

6. Ties below prize places share the place, with a warning.

7. Ranking: standard (1,2,2,4) by default. Continuous only after a
   shared 1st.

8. Absent (new separate status): a judge marks Absent; one judge is
   enough. The organiser gets a bell notification with Confirm or
   Reject.
   Confirm: Absent and sealed, excluded from ranking and ties.
   Reject: the participant reappears on the judge's list, and the judge
   is notified at once.
   Show "Absent", never "0". Log every request and decision.
   FIX: the tie detector counts a zero as a mark. It must skip Absent.

9. Not Ready (judge side only): the participant moves to the bottom with
   a "Not Ready" tag and keeps the organiser's position number. One tap
   to unmark. No server write.

10. Score One by One (per event, default OFF): the judge sees only the
    current participant. The organiser moves to the next one. The server
    refuses a mark for anyone not current.

11. Change Order (Events tab): button "Change order". Delete hidden,
    boxes dimmed, press and hold to drag, button becomes "Done", Undo.
    Only before start or while paused. Greyed out while running. Warn if
    judges are scoring.

12. Re-compete judge screen: five buttons A=5, B=4, C=3, D=2, E=1.
    Judges see only their own grades in an open round. Sealed marks never
    change. A late offline grade on a closed round is dropped with a
    message. Final order: grade total, then countback on sealed marks,
    then shared place.

13. Projector: "Tie round in progress" while open. Final ranks after
    publish.

14. Insights and PDFs: audit section in Insights. Results PDF gets the
    full audit table. Logs PDF gets one summary line.

15. Audit log: every tie action recorded (who, when, event, rule,
    result, reason). Append-only.

16. Load: heavy checks only at End, Preview and Confirm, not on every
    score. Re-compete refresh every 8 seconds, only while a round is open.

17. SQL: small files, one check each. Owner runs them. Do not run SQL.
