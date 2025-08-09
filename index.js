import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy } from "passport-local";
import session from "express-session";
import env from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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

const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});
db.connect();

app.get('/', async (req, res) => {
  try {
    const result = await db.query(`
  SELECT 
    posts.*, 
    COUNT(likes.id) AS like_count
  FROM posts
  LEFT JOIN likes ON posts.id = likes.post_id
  GROUP BY posts.id
  ORDER BY posts.created_at DESC;`);
    res.render('home.ejs', { posts: result.rows });
  } catch (err) {
    console.error(err);
    res.render('home.ejs', { posts: [] });
  }
});


app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.get("/register", (req, res) => {
  res.render("register.ejs");
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
    const posts = await db.query(`
  SELECT 
    posts.*, 
    COUNT(likes.id) AS like_count
  FROM posts
  LEFT JOIN likes ON posts.id = likes.post_id
  WHERE posts.user_id = $1
  GROUP BY posts.id
  ORDER BY posts.created_at DESC;`, [req.user.id]);

    const likedPosts = await db.query(
      "SELECT post_id FROM likes WHERE user_id = $1",
      [req.user.id]
    );
    const likedPostIds = likedPosts.rows.map(row => row.post_id);

    const result = await db.query("SELECT about FROM users WHERE id = $1", [req.user.id]);
    const username= req.user.username;
    const aboutMe= result.rows[0].about?.trim() || `Hi I am ${username}— an animal lover through and through.`;

    res.render("user.ejs", {
      posts: posts.rows,
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
    const posts = await db.query(`
  SELECT 
    posts.*, 
    COUNT(likes.id) AS like_count
  FROM posts
  LEFT JOIN likes ON posts.id = likes.post_id
  GROUP BY posts.id
  ORDER BY posts.created_at DESC;`);

    const likedPosts = await db.query(
      "SELECT post_id FROM likes WHERE user_id = $1",
      [req.user.id]
    );
    const likedPostIds = likedPosts.rows.map(row => row.post_id);
    res.render("main.ejs", {
      posts: posts.rows,
      username: req.user.username,
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
  const email = req.body.email;
  const password = req.body.password;
  const username= req.body.username;

  try {
    const checkResult = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (checkResult.rows.length > 0) {
      res.redirect("/login");
    } else {
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          console.error("Error hashing password:", err);
        } else {
          const result = await db.query(
            "INSERT INTO users (email, password, username) VALUES ($1, $2, $3) RETURNING *",
            [email, hash, username]
          );
          const user = result.rows[0];
          req.login(user, (err) => {
            console.log("success");
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
      const result = await db.query("SELECT * FROM users WHERE email = $1 ", [
        email,
      ]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
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
        await db.query(
            'UPDATE users SET about = $1 WHERE id = $2',
            [about, userId]
        );

        res.redirect('/user');
    } catch (err) {
        console.error('Error updating about section:', err);
        res.status(500).send('Internal Server Error');
    }
});


app.post("/add-post", upload.single("image"), async (req, res) => {
  const { title, content } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

  if (!req.isAuthenticated()) return res.redirect("/login");
  try {
    await db.query(
      "INSERT INTO posts (user_id, title, content, image) VALUES ($1, $2, $3, $4)",
      [req.user.id, title, content, imagePath]
    );
    res.redirect("/user");
  } catch (err) {
    console.log(err);
    res.send("Error adding post");
  }
});

// EDIT - Load the form pre-filled
app.get("/edit/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM posts WHERE id = $1", [req.params.id]);
    res.render("edit.ejs", { post: result.rows[0] });
  } catch (err) {
    res.send("Post not found");
  }
});

// EDIT - Save the updated post
app.post("/edit/:id", async (req, res) => {
  const { title, content, image } = req.body;
  try {
    await db.query("UPDATE posts SET title = $1, content = $2, image = $3 WHERE id = $4", [
      title,
      content,
      image,
      req.params.id,
    ]);
    res.redirect("/user");
  } catch (err) {
    res.send("Error editing post");
  }
});

//DELETE POST
app.post("/delete/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    res.redirect("/user");
  } catch (err) {
    res.send("Error deleting post");
  }
});

// Like Post
app.post("/like/:id", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/login");
  try {
    await db.query("INSERT INTO likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      req.user.id,
      req.params.id,
    ]);
    res.redirect(req.get("Referer") || "/");
  } catch (err) {
    res.send("Error liking post");
  }
});

//ADD COMMENT
app.post("/comment/:id", async (req, res) => {
  const content = req.body.content;
  if (!req.isAuthenticated()) return res.redirect("/login");
  try {
    await db.query("INSERT INTO comments (user_id, post_id, content) VALUES ($1, $2, $3)", [
      req.user.id,
      req.params.id,
      content,
    ]);
    res.redirect("/user");
  } catch (err) {
    res.send("Error commenting");
  }
});


passport.serializeUser((user, cb) => {
  cb(null, user);
});
passport.deserializeUser((user, cb) => {
  cb(null, user);
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});