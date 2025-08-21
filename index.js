import express from "express";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy } from "passport-local";
import session from "express-session";
import validator from "validator";
import env from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import sql from './db.js';

const app = express();
const port = 3000;
const saltRounds = 10;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
env.config();

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 1000*60*60*24*3
    }
  })
);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(express.json());


app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // unique filename
  },
});
const upload = multer({ storage });

app.use(passport.initialize());
app.use(passport.session());


//DB HEALTH CHECK
app.get("/health", async (req, res) => {
  try {
    await sql`SELECT 1`; // test query
    res.status(200).json({ status: "ok", message: "Database connection is healthy ✅" });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(500).json({ status: "error", message: "Database connection failed ❌" });
  }
});

app.get('/', async (req, res) => {
  try {
    const result = await sql`
  SELECT 
    posts.*, 
    COUNT(likes.id) AS like_count
  FROM posts
  LEFT JOIN likes ON posts.id = likes.post_id
  GROUP BY posts.id
  ORDER BY posts.created_at DESC;`;
    res.render('home.ejs', { posts: result });
  } catch (err) {
    console.error(err);
    res.render('home.ejs', { posts: [] });
  }
});


app.get("/login", (req, res) => {
  if (req.isAuthenticated()){
    res.redirect("/main");
  } else {
    res.render("login.ejs");
  }
});

app.get("/register", (req, res) => {
  if (req.isAuthenticated()){
    res.redirect("/main");
  } else {
    res.render("register.ejs");
  }
});

app.get("/logout", (req, res) => {
  req.logout(function (err) {
    if (err) {
      return next(err);
    }
    res.redirect("/");
  });
});

app.get("/user", async (req, res) => {
  if (req.isAuthenticated()) {
    const posts = await sql`
  SELECT 
    posts.*, 
    COUNT(likes.id) AS like_count
  FROM posts
  LEFT JOIN likes ON posts.id = likes.post_id
  WHERE posts.user_id = ${req.user.id}
  GROUP BY posts.id
  ORDER BY posts.created_at DESC;`;

    const likedPosts = await sql
      `SELECT post_id FROM likes WHERE user_id = ${req.user.id};`;
    const likedPostIds = likedPosts.map(row => row.post_id);

    const result = await sql`SELECT about FROM users WHERE id = ${req.user.id};`;
    const username= req.user.username;
    const aboutMe= result[0]?.about?.trim() || `Hi I am ${username}— an animal lover through and through.`;

    res.render("user.ejs", {
      posts: posts,
      username: username,
      aboutMe: aboutMe,
      likedPostIds
    });
  } else {
    res.redirect("/login");
  }
});

app.get("/main", async (req, res) => {
  if (req.isAuthenticated()) {
    const posts = await sql`
  SELECT 
    posts.*, 
    users.username AS blogger_name,
    users.id AS blogger_id,
    COUNT(likes.id) AS like_count
  FROM posts
  JOIN users ON posts.user_id = users.id
  LEFT JOIN likes ON posts.id = likes.post_id
  GROUP BY posts.id, users.id
  ORDER BY posts.created_at DESC;`;

    const likedPosts = await sql`
      SELECT post_id FROM likes WHERE user_id = ${req.user.id};`;
    const likedPostIds = likedPosts.map(row => row.post_id);
    res.render("main.ejs", {
      posts: posts,
      username: req.user.username,
      user_id: req.user.id,
      likedPostIds
    });
  } else {
    res.redirect("/login");
  }
});

app.post(
  "/login",
  passport.authenticate("local", {
    successRedirect: "/main",
    failureRedirect: "/login",
    failureMessage: true
  })
);

app.post("/register", async (req, res) => {
  const { email, password, username } = req.body;
  const about_me= `Hi I am ${username}— an animal lover through and through.`;


  if (!validator.isEmail(email)) {
    return res.status(400).send("Invalid email format");
  }
  
  try {
    const checkResult = await sql`SELECT * FROM users WHERE email = ${email};`;

    if (checkResult.length > 0) {
      res.redirect("/login");
    } else {
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          console.error("Error hashing password:", err);
        } else {
          const result = await sql
            `INSERT INTO users (email, password, username, about) VALUES (${email}, ${hash}, ${username}, ${about_me}) RETURNING *;`;
          const user = result[0];
          req.login(user, (err) => {
            res.redirect("/main");
          });
        }
      });
    }
  } catch (err) {
    console.log(err);
  }
});

passport.use(
  new Strategy(
    { usernameField: "email" },
    async function verify(email, password, cb) {
    try {
      const result = await sql`SELECT * FROM users WHERE email = ${email};`;
      if (result.length > 0) {
        const user = result[0];
        const storedHashedPassword = user.password;
        bcrypt.compare(password, storedHashedPassword, (err, valid) => {
          if (err) {
            //Error with password check
            console.error("Error comparing passwords:", err);
            return cb(err);
          } else {
            if (valid) {
              //Passed password check
              return cb(null, user);
            } else {
              //Did not pass password check
              return cb(null, false);
            }
          }
        });
      } else {
        return cb("User not found");
      }
    } catch (err) {
      console.log(err);
    }
  })
);

//UPDATE ABOUT SECTION
app.post('/update-about', async (req, res) => {
    const { about } = req.body;
    const userId = req.user.id;

    try {
        await sql
            `UPDATE users SET about = ${about} WHERE id = ${userId};`;

        res.redirect('/user');
    } catch (err) {
        console.error('Error updating about section:', err);
        res.status(500).send('Internal Server Error');
    }
});

// NEW POST
app.post("/add-post", upload.single("image"), async (req, res) => {
  const { title, content } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

  if (!req.isAuthenticated()) return res.redirect("/login");
  try {
    await sql
      `INSERT INTO posts (user_id, title, content, image) VALUES (${req.user.id}, ${title}, ${content}, ${imagePath});`
    ;
    res.redirect("/user");
  } catch (err) {
    console.log(err);
    res.send("Error adding post");
  }
});

// EDIT - Load the form pre-filled
app.get("/edit/:id", async (req, res) => {
  try {
    const result = await sql`SELECT * FROM posts WHERE id = ${req.params.id};`;
    res.render("edit.ejs", { post: result[0] });
  } catch (err) {
    res.send("Post not found");
  }
});

// EDIT - Save the updated post
app.post("/edit/:id", upload.single("image"), async (req, res) => {
  const { title, content } = req.body;
  let imagePath = null;

  try {
    const result = await sql`SELECT image FROM posts WHERE id = ${req.params.id};`;
    const oldImagePath = result[0]?.image;

    if (req.file){
      imagePath= `/uploads/${req.file.filename}`;

      if (oldImagePath) {
        const fullOldImagePath = path.join(__dirname, "public", oldImagePath.replace(/^\//, ""));
        if (fs.existsSync(fullOldImagePath)) {
          fs.unlinkSync(fullOldImagePath);
        }
      }
    } else {
      if (oldImagePath) {
        const fullOldImagePath = path.join(__dirname, "public", oldImagePath.replace(/^\//, ""));
        if (fs.existsSync(fullOldImagePath)) {
          fs.unlinkSync(fullOldImagePath);
        }
      }
      imagePath = null;
    }

    await sql`UPDATE posts SET title = ${title}, content = ${content}, image = ${imagePath} WHERE id = ${req.params.id};`;
    res.redirect("/user");
  } catch (err) {
    res.send("Error editing post:" + err);
  }
});

//DELETE POST
app.post("/delete/:id", async (req, res) => {
  try {
    await sql`DELETE FROM posts WHERE id = ${req.params.id};`;
    res.redirect("/user");
  } catch (err) {
    res.send("Error deleting post");
  }
});

// Like a Post
app.post("/like/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    if (req.xhr || req.get("Accept")?.includes("application/json")) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    return res.redirect("/login");
  }
  try {
    const existingLike = await sql
      `SELECT id FROM likes WHERE user_id = ${req.user.id} AND post_id = ${req.params.id};`;

    if (existingLike.length > 0) {
      // Unlike
      await sql`DELETE FROM likes WHERE user_id = ${req.user.id} AND post_id = ${req.params.id};`;
    } else {
      // Like
      await sql`
        INSERT INTO likes (user_id, post_id) 
        VALUES (${req.user.id}, ${req.params.id})
        ON CONFLICT DO NOTHING;
      `;
    }
    const lc = await sql`
      SELECT COUNT(*)::int AS count 
      FROM likes 
      WHERE post_id = ${req.params.id};
    `;
    const likeCount = lc[0].count;

    return res.json({
      like_count: likeCount,
      liked: existingLike.length === 0,
    });
    
  } catch (err) {
    console.error(err);
    if (req.xhr || req.get("Accept")?.includes("application/json")) {
      return res.status(500).json({ error: "server_error" });
    }
    res.send("Error liking post");
  }
});

app.get("/:blogger_name/:blogger_id", async (req, res) => {
    const { blogger_id } = req.params;

    try {
        const result = await sql
            `SELECT id, username, about FROM users WHERE id = ${blogger_id};`;

        if (result.length === 0) {
            return res.status(404).send("User not found");
        }
        const blogger = result[0];

        const posts = await sql
            `SELECT posts.*,
                COUNT(likes.id) AS like_count
             FROM posts
             LEFT JOIN likes ON posts.id = likes.post_id
             WHERE posts.user_id = ${blogger_id}
             GROUP BY posts.id
             ORDER BY posts.created_at DESC;`;

        const likedPosts = await sql`
          SELECT post_id FROM likes WHERE user_id = ${req.user.id}
        `;
        const likedPostIds = likedPosts.map((row) => row.post_id);

        res.render("blogger.ejs", {
            blogger,
            posts,
            likedPostIds,
            user: req.user //current user
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Server error");
    }
});


passport.serializeUser((user, cb) => {
  cb(null, user);
});
passport.deserializeUser((user, cb) => {
  cb(null, user);
});


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});