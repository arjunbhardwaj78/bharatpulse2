# 3-minute demo (all data on screen is synthetic)

Setup: server and web running (`npm run dev:server`, `npm run dev:web`). Officer portal open at `/#/officer`, signed in as `zonal1`, on the **Sample data** page. Citizen page open on a phone or a narrow window, signed in.

| Time | Do | Say |
|---|---|---|
| 0:00 | Slide: the user, a zonal water officer | "A zonal officer gets dozens of complaints and cannot tell which are real." |
| 0:20 | Citizen page: your location is found on its own; tap Water, press the mic and speak in Hindi (words appear), add a photo, submit. Then show the problems near you with their "I have this too" buttons | "Three taps, in the user's language. Sarvam turns speech into text." (No Sarvam key: type a Hindi or Hinglish sentence.) |
| 0:50 | Sample data page: drag the replay slider from 0 to 120 | "Reports trickle in. Watch the moment it becomes an incident, and how many independent sources it is built on." |
| 1:20 | Click "Fake: 50 reports, 3 phones" | "50 reports, but three phones." Open the new incident: raw 50, independent 3, purple "Needs verification". Open **Graph**: the three red phones. "Neo4j counts every account on a device across all incidents. That is one query, not code." |
| 2:00 | Click "Real outage (30)" (or Load sample town) | "A genuine mass outage looks different: many unrelated people." Show it is not flagged and ranks High. This is the hard case, so say it out loud. |
| 2:20 | Sign in as field1 to verify and resolve with a proof photo, zonal1 to approve and assign; on the citizen page My complaints shows the cycle moving; tap "Yes, it is fixed"; open the certificate. To show objections: reject as field1, then press "Raise an objection" as the citizen, and decide it as head1 | "The loop closes with proof and the citizen's confirmation. Only a verified, fixed incident earns the certificate." |
| 2:25 | Citizen page: show the planned-work banner, tap "Yes, on time" in the water diary, then the public page's water supply section | "People get a planned cut explained before they complain, and one tap a day builds evidence of which wards really lose water." |
| 2:35 | Open the public page (`/#/community`) | "Anyone can see how their ward is doing and the repair photos. That accountability is the point." |
| 2:50 | Slide: numbers from `npm run eval` | "15 of 15 naive fake campaigns caught, 0 of 10 genuine outages flagged. A careful attacker whose reports look human gets through: 0 of 5. We make attacks expensive and visible, not impossible." |

Keep a recorded video of this run as a backup in case the network fails.
