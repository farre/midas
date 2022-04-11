#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

std::mutex g_stdio_mutex;
struct Foo {
  double x, y;
};

struct Surface {
  int width;
  int height;
  // mapping onto the surface's dimensions
  struct Mapping {
    double min;
    double max;
  } x, y;
};

auto broke_free(auto a, auto b, Foo test) {
  Foo bar = test;
  if (a != 4.0) {
    auto foo = a + 1;
  }
  return (a + b) > 4.0;
}

using Iterations = int;
Iterations mandelbrot(double real, double imag, int limit = 100) {
  double re = real;
  double im = imag;

  for (int i = 0; i < limit; ++i) {
    double r2 = re * re;
    double i2 = im * im;

    if (broke_free(r2, i2, Foo{.x = r2, .y = i2}))
      return Iterations{i};

    im = 2.0 * re * im + imag;
    re = r2 - i2 + real;
  }
  return Iterations{limit};
}

// lets pretend this looks up cpus
auto ncpus_to_use() { return 4; }

void process_range(Surface surface, int y_start, int y_to) {
  const auto dx =
      (surface.x.max - surface.x.min) / static_cast<double>(surface.width - 1);
  const auto dy =
      (surface.y.max - surface.y.min) / static_cast<double>(surface.height - 1);
  auto copy = surface;
  // to test watch variables, set breakpoint on limit, and breakpoint on line
  // 86, add watch variable copy.x (or copy.y). Then run and when stopped and
  // select different threads
  int limit = 1200;
  auto escaped = 0;
  auto contained = 0;
  auto total = 0;
  const auto one_third = ((y_to - y_start) / 3) + y_start;
  const auto two_thirds = ((y_to - y_start) / 3) * 2 + y_start;
  bool hitOnce = false;
  for (auto x = 0; x < surface.width; x++) {
    for (auto y = y_start; y < y_to; ++y) {
      const auto r =
          mandelbrot(surface.x.min + x * dx, surface.y.max - y * dy, limit);
      if (r != limit) {
        contained++;
      } else {
        escaped++;
      }
      total++;
      if (y == one_third) {
        // this is for testing that watch variables work, and get updated, when
        // different threads are selected. to test: set a watch variable for
        // copy.x or copy.y and see if it updates accordingly
        copy.x.max = y;
        copy.y.max = y;
        copy.x.min = y;
        copy.y.min = y;

        auto some_break_point_here2 = [] {};
        some_break_point_here2();
      }
      if (y == two_thirds && !hitOnce) {
        hitOnce = true;
        auto some_break_point_here = [] {};
        some_break_point_here();
      }
    }
  }
  {
    const std::lock_guard lock(g_stdio_mutex);
    std::cout << y_start << " -> " << y_to << " (" << total << ")" << std::endl;
    std::cout << escaped << " spun out of control " << contained
              << " was contained in the mandelbrot field " << std::endl;
  }
}

void vecOfString() {
  std::vector<std::string> env_variables;
  env_variables.reserve(10);

  const auto push_env_var_if = [&](auto env) {
    if (auto var = std::getenv(env); var) {
      env_variables.emplace_back(var);
    }
  };

  push_env_var_if("PATH");
  push_env_var_if("PWD");
  push_env_var_if("USER");
  push_env_var_if("USERNAME");
  push_env_var_if("DISPLAY");
  push_env_var_if("PATH");
  push_env_var_if("SHELL");
  push_env_var_if("HOME");

  for (const auto &var : env_variables) {
    std::cout << var << std::endl;
  }
}

void process_tasks_and_run(int screen_width, int screen_height) {
  const auto jobs = ncpus_to_use();
  const auto job_size = screen_height / jobs;
  std::vector<std::thread> tasks;
  tasks.reserve(jobs);
  const auto surface = Surface{.width = screen_width,
                               .height = screen_height,
                               .x = {-2.0, 1.0},
                               .y = {-1.0, 1.0}};
  for (auto i = 0; i < screen_height; i += job_size) {
    tasks.push_back(std::thread{process_range, surface, i, i + job_size});
  }
  std::cout << jobs << " jobs spun up" << std::endl;
  for (auto &t : tasks)
    t.join();
}

auto test_evaluate_variables_when_passing_through_scopes() {
  std::cout << "in main, w and h are ints" << std::endl;
  float w = 3.14;
  float h = 66.6;
  std::cout << w << ", " << h << std::endl;
}

void tuple_tuples() {
  std::tuple<int, std::tuple<int, int, std::string>, std::string> hmm{
      1, {2, 3, "inner"}, "outer"};
  std::cout << "tuples are... meh" << std::endl;
}

int main(int argc, const char **argv) {
  std::string hw = "Hello World";
  vecOfString();
  tuple_tuples();
  auto w = 4000;
  auto h = 4000;
  test_evaluate_variables_when_passing_through_scopes();
  process_tasks_and_run(w, h);
  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  std::cout << "Goodbye cruel world" << std::endl;
}
