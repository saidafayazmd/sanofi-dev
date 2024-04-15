const express = require("express");
const axios = require("axios");
const Room = require("../models/room");
const Status = require("../models/ExpertStatus");
const router = express.Router();
const AUTH = require("../middleware/cognitoAuthUser");
const auth = require("../middleware/auth");
const logger = require("../logger/index");
const { skillTags } = require("../models/skills");
const { encrypt, decrypt } = require('../middleware/crypto');
require("dotenv/config");

// Initialize meeting API
// 1. Logging into bluejeans to obtain access token
// returns bluejeans user object. Use access_token to allow room creation
// 2. calling the create_room api to create a room in rooms collection on sucessful bluejeans login with payload :
// access_id : scope.user from bluejeans response
// token : access_token from bluejeans response
// expert_needed : from req.body
// timezone : from req.body
// userID : collection id from body which is sent in response after login
// field_worker_details : details of field worker which is sent in response after login

router.post("/initialize_meeting", AUTH.verifyToken, function(req, res) {
  var temp = req.body.extras_field[0].Bluejeans_Credentials
  const username = req.body.extras_field[0].Bluejeans_Credentials.username;
  const password = decrypt({ content: temp.password, iv: temp.iv })
  const expert_needed = req.body.skill_category_title;
  const user_ID = req.body._id;
  const full_name = `${req.body.first_name} ${req.body.last_name}`;
  axios
    .post("https://api.bluejeans.com/oauth2/token?Password", {
      grant_type: "password",
      username: username,
      password: password,
    })
    .then(async(result) => {
      const token = result.data.access_token;
      const access_id = result.data.scope.user;
      const payload = {
        access_id,
        token,
        expert_needed,
        timezone: req.body.timezone,
        userID: user_ID,
        field_worker_details: req.body,
        full_name,
      };
      await axios
        .post(`${process.env.BASE_URI_DEV}/bluejeans/create_room`, payload)
        .then(async(response) => {
          const details = response.data;
          const meeting_details = {
            Meeting_Host: details.meetingHost,
            Meeting_Room_ID: details.meetingID,
            Start_Time: details.startTime,
            End_Time: details.endTime,
            Expert_category: expert_needed,
          };
          res.status(200).send(meeting_details);
          await axios
            .post(
              `${process.env.BASE_URI_DEV}/user/notification`, {

                accessToken: req.accessToken,
                expert_skill: expert_needed,
                room: "" + details.numericMeetingId,
              }, {
                headers: { Authorization: `BEARER ${req.accessToken}` },
              }
            )
            .then((ress) => console.log(ress))
            .catch((err) => console.log(err));
        })
        .catch((err) => {
          logger.error(err.message);
          res.status(500).send(err.message);
        });
    })
    .catch((err) => {
      logger.error(err.message);
      res.status(500).send(err.message);
    });
});

// creates bluejeans room
// required input from response on bluejeans login route:
// access_id = req.body
// token = req.body
// expert_needed = req.body
// userID = req.body

// Once room is created succesfully details of room are added in collection Room using api "post_room"

router.post("/create_room", async function(req, res) {
  const access_id = req.body.access_id;
  const token = req.body.token;
  const expert_needed = req.body.expert_needed;
  const userID = req.body.userID;
  // const description = req.body.description;
  const timezone = req.body.timezone;
  await axios
    .post(
      `https://api.bluejeans.com/v1/user/${access_id}/scheduled_meeting?access_token=${token}`, {
        title: expert_needed,
        description: "Emergency",
        start: Date.now(),
        end: Date.now() + 30,
        timezone: timezone,
        addAttendeePasscode: false,
        endPointVersion: "2.10",
        endPointType: "ANDROID_APP",
        attendees: [],
        advancedMeetingOptions: {
          autoRecord: false,
          muteParticipantsOnEntry: false,
          encryptionType: "NO_ENCRYPTION",
          moderatorLess: true,
          videoBestFit: true,
          disallowChat: false,
          publishMeeting: true,
          showAllAttendeesInMeetingInvite: true,
        },
      }
    )
    // .then((res) => res.data)
    .then(async(data) => {
      data = data.data;
      const payload = {
        blueJeans_ID: data.id,
        expert_skill_title: expert_needed,
        meetingHost: req.body.full_name,
        meetingID: data.numericMeetingId,
        host_userID: userID,
        startTime: Date.now(),
        endTime: Date.now() + 3000,
        timeZone: timezone,
        current_participants: [req.body.field_worker_details],
        meeting_ongoing_status: true,
        access_ID: access_id,
        access_token: token,
      };
      await axios
        .post(`${process.env.BASE_URI_DEV}/bluejeans/post_room`, payload)
        .then((response) => {
          res.status(200).send(response.data);
        })
        .catch((err) => {
          logger.error(err.message);
          res.status(500).send(err.message);
        });
    })
    .catch((err) => {
      logger.error(err.message);
      res.status(err.response.data.code).send(err.response.data.message);
    });
});

// posts room information to DB
// input required from create_room route response:

// TODO : Find all experts who are online with requested skill set using api "online_expert_skill" and send push notification
//        with document id  from rooms collection of the room created using firebase

router.post("/post_room", async(req, res) => {
  const {
    blueJeans_ID,
    expert_skill_title,
    meetingHost,
    meetingID,
    host_userID,
    endTime,
    timeZone,
    current_participants,
    meeting_ongoing_status,
    access_ID,
    access_token,
  } = req.body;

  let room = new Room({
    blueJeans_ID: blueJeans_ID,
    expert_skillCategory_name: expert_skill_title,
    meetingHost: meetingHost,
    meetingID: meetingID,
    host_userID: host_userID,
    startTime: Date.now(),
    endTime: endTime,
    timeZone: timeZone,
    current_participants: current_participants,
    meeting_ongoing_status: meeting_ongoing_status,
    access_ID: access_ID,
    access_token: access_token,
    participants_stats: [],
    total_participants: 0,
  });
  await room
    .save()
    .then((result) => {
      // console.log({ post_room: result });
      res.status(200).send(result);
    })
    .catch((err) => {
      console.log(err);
    });

  // res.status(200).json(room);
});

// retieves all help requests that an expert has the credibility to help with
// input:
// expert_title = the type of expert an expert user is
// TODO: need to discuss more in detail how we are going to parse help requests that are more suitable for the expert
// router.get("/get_help_requests", async (req, res) => {
//   try {
//     await Room.find((err, data) => {
//       if (err) {
//         console.log(err);
//         res.status(400).send({ message: "Error in fetching data" });
//         res.send({ message: "Error in fetching data" });
//       } else {
//         var info = data.map((val) => {
//           return Room.find({ expert_needed: req.body.expert_title }).then(
//             (res) => {
//               return res;
//             }
//           );
//         });
//         Promise.all(info).then(function (onlineRoomsInfo) {
//           if (onlineRoomsInfo[0].length === 0) {
//             res.status(400).json({ message: "No experts are available" });
//           } else if {
//             res.status(200).json(onlineRoomsInfo[0]);
//             res.json({ message: "No experts are available" });
//           } else {
//             res.json(onlineRoomsInfo[0]);
//           }
//         });
//       }
//     });
//   } catch (e) {
//     res.status(500).send({ message: "Error fetching user" });
//     res.send({ message: "Error fetching user" });
//   }
// });

// This API needs to be called from expert app after they get push notification to join room
// Document ID from Room collection needs to be sent via push notification to concerned expert using firebase
// When this API is called with documentID in body and token that we have sent after login in header, expert is authenticated using middleware.
//   After expert authentication, bluejeans api is called to check how many participants are in the room.
//   If more than one person is present in room check for field worker who has started the room by name,else send respective response.

// TODO : Create API to remove participants after field worker exits

router.post("/join_expert", AUTH.verifyToken, async(req, res) => {
  const documentID = req.body.joiningID;
  try {
    await Room.findById(documentID, (err, data) => {
      if (err) {
        res.status(500).send({ message: "Something went wrong" });
      }
      else {
        const meeting_details = {
          Meeting_Host: data.meetingHost,
          Meeting_Room_ID: data.meetingID,
          Start_Time: data.startTime,
          End_Time: data.endTime,
          Expert_category: data,
        };
        res.send(200).send(meeting_details);
      }
    });
  }
  catch (e) {
    logger.error(e.message);
    res.status(400).send({ message: "Error Joining" });
  }
});

// This API is used to fetch all online experts with required skill category

router.post("/online_expert_skill", AUTH.verifyToken, async(req, res) => {
  try {
    let skillTag = req.body.skillTag;
    await Status.find({
      $and: [{ skill_tags: { $regex: new RegExp(skillTag, "i") } }, { onlineStatus: true }],
    }).exec((err, data) => {
      if (err) {
        console.log(err);
        res.status(400).send({ message: "Error in fetching data" });
      }
      else {
        res.status(200).json(data);
      }
    });
  }
  catch (e) {
    logger.error(e);
    res.status(400).send({ message: "Error fetching experts" });
  }
});

router.get("/get_all_active_rooms", AUTH.verifyToken, async(req, res) => {
  try {
    await Room.find((err, data) => {
      if (err) {
        console.log(err);
        res.status(400).send({ message: "Error in fetching data" });
      }
      else {
        var info = data.map((val) => {
          return Room.find({ meeting_ongoing_status: true }).then((res) => {
            return res;
          });
        });
        Promise.all(info).then(function(onlineRoomsInfo) {
          if (onlineRoomsInfo[0].length === 0) {
            res.status(200).json({ message: "No active rooms available" });
          }
          else {
            res.status(200).json(onlineRoomsInfo[0]);
          }
        });
      }
    });
  }
  catch (e) {
    logger.error(e);
    res.status(400).send({ message: "Error fetching user" });
  }
});

router.post("/current_participants_in_room", AUTH.verifyToken, (req, res) => {
  const user_ID = req.body.id;
  const meeting_ID = req.body.meetingID;
  const access_token = req.body.access_token;
  axios
    .get(
      `https://api.bluejeans.com/v1/user/${user_ID}/scheduled_meeting/${meeting_ID}?access_token=${access_token}`
    )
    .then((data) => res.status(200).json(data.data.attendees))
    .catch((err) => {
      logger.error(err.message);
      res.status(500).send(err.message);
    });
});

// Change room status to closed

router.post("/update_room_status", AUTH.verifyToken, function(req, res) {
  const id = req.body.id;
  Room.findOneAndUpdate({ _id: id }, { meeting_ongoing_status: req.body.meeting_ongoing_status },
    (err, data) => {
      if (err) {
        logger.error(err);
        res.status(500).send();
      }
      else {
        if (!data) {
          res.status(404).send();
        }
        else {
          res.status(200).send("Meeting status Updated");
        }
      }
    }
  );
});

// end meeting Api

router.post("/end_meeting", AUTH.verifyToken, async(req, res) => {
  try {
    const meetingID = req.body.meetingID;
    await Room.findOne({ meetingID: meetingID }, (err, doc) => {
      if (err) {
        logger.error(err);
        res.status(400).json({ error: 2, message: "Could not find meeting" });
      }
      doc.endTime = Date.now();
      axios
        .get(
          `https://api.bluejeans.com/v1/user/${doc.access_ID}/live_meetings/${meetingID}/endpoints?access_token=${doc.access_token}`
        )
        .then((result) => {
          const data = result.data;
          const endPoints = [];
          if (data.length === 0) {
            res
              .status(200)
              .json({ error: 0, message: "Nobody in meeting room" });
          }
          else {
            data.map((val) => {
              endPoints.push(val.endpointGuid.replace(":", "%3A"));
            });
            if (endPoints.length > 0) {
              var info = endPoints.map((val, key) => {
                return axios
                  .put(
                    `https://api.bluejeans.com/v1/user/${doc.access_ID}/live_meetings/${meetingID}/endpoints/${val}?leaveMeeting=true&access_token=${doc.access_token}`
                  )
                  .then((result) => {
                    return result.status;
                  })
                  .catch((err) => {
                    res.status(500).send("something went wrong!");
                  });
              });
              Promise.all([info]).then(async(result) => {
                const payload = {
                  id: doc.id,
                  meeting_ongoing_status: false,
                };
                await axios
                  .post(
                    `${process.env.BASE_URI_DEV}/bluejeans/update_room_status`,
                    payload, {
                      headers: { Authorization: `BEARER ${req.accessToken}` },
                    }
                  )
                  .then(async(response) => {
                    if (result.every((val, i, arr) => val === arr[0])) {
                      var diff = Math.abs(doc.endTime - doc.startTime);
                      var minutes = Math.floor(diff / 1000 / 60);
                      await Room.updateMany({ meetingID: doc.meetingID }, {
                          $set: {
                            endTime: doc.endTime,
                            total_meeting_time: minutes,
                          },
                        }, { multi: true },
                        (err, status) => {
                          if (err) {
                            logger.error(err);
                            res
                              .status(404)
                              .json({ error: 1, message: err.message });
                          }
                          else {
                            res.status(200).json({
                              error: 0,
                              message: "Updated Room status",
                            });
                          }
                        }
                      ).catch((e) => {
                        logger.error(e);
                        res.status(500).send("Room not closed");
                      });
                    }
                    else {
                      res
                        .status(500)
                        .send("All participants were not removed succesfully");
                    }
                  });
              });
            }
          }
        })
        .catch((e) => {
          res.send(500).end();
        });
    });
  }
  catch (e) {
    res.send(500).end();
  }
});

//make all meeting rooms inactive

router.get("/make_room_inactive", async(req, res) => {
  await Room.find({ meeting_ongoing_status: true })
    .then((data) => {
      if (data.length > 0) {
        data.map(async(val) => {
          await Room.findByIdAndUpdate(val._id, {
            meeting_ongoing_status: false,
          });
        });
        res.status(200).end();
      }
      else {
        res.status(200).send("No active rooms");
      }
    })
    .catch((err) => console.log(err));
});

module.exports = router;
