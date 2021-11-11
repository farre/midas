#include <iostream>
#include <vector>
#include <thread>
#include <chrono>
#include <mutex>

std::mutex g_stdio_mutex;

struct Surface {
  int width;
  int height;
  // mapping onto the surface's dimensions
  struct Mapping {
    double min;
    double max;
  } x, y;
};
using Iterations = int;
Iterations mandelbrot(double real, double imag, int limit = 100) {
	double re = real;
	double im = imag;

	for (int i = 0; i < limit; ++i) {
		double r2 = re * re;
		double i2 = im * im;

		if (r2 + i2 > 4.0) return Iterations { i };

		im = 2.0 * re * im + imag;
		re = r2 - i2 + real;
	}
	return Iterations { limit };
}

// lets pretend this looks up cpus
auto ncpus() { return std::thread::hardware_concurrency(); }

void process_range(Surface surface, int y_start, int y_to) {
  const auto dx = (surface.x.max - surface.x.min) / static_cast<double>(surface.width - 1);
  const auto dy = (surface.y.max - surface.y.min) / static_cast<double>(surface.height - 1);
  int limit = 1200;
  auto escaped = 0;
  auto contained = 0;
  auto total = 0;
  const auto two_thirds = ((y_to - y_start) / 3) * 2 + y_start;
  bool hitOnce = false;
  for(auto x = 0; x < surface.width; x++) {
    for(auto y = y_start; y < y_to; ++y) {
      const auto r = mandelbrot(surface.x.min + x * dx , surface.y.max - y * dy, limit);
      if(r != limit) {
        contained++;
      } else {
        escaped++;
      }
      total++;
      if(y == two_thirds && !hitOnce) {
        hitOnce = true;
        auto some_break_point_here = []{};
        some_break_point_here();
      }
    }
  }
  {
    const std::lock_guard lock(g_stdio_mutex);
    std::cout << y_start << " -> " << y_to << " (" << total << ")" <<std::endl;
    std::cout << escaped << " spun out of control " << contained << " was contained in the mandelbrot field " << std::endl;
  }

}

void process_tasks_and_run(int screen_width, int screen_height) {
  const auto jobs = ncpus() - 1;
  const auto job_size = screen_height / jobs;
  std::vector<std::thread> tasks;
  tasks.reserve(jobs);
  const auto surface = Surface{ .width = screen_width, .height = screen_height, .x = {-2.0, 1.0 }, .y = { -1.0, 1.0 } };
  for(auto i = 0; i < screen_height; i+=job_size) {
    tasks.push_back(std::thread{process_range, surface, i, i+job_size});
  }
  std::cout << jobs << " jobs spun up" << std::endl;
  for(auto& t : tasks) t.join();
}

int main(int argc, const char **argv) {
  // so that we can test pausing execution, for instance.
  process_tasks_and_run(3840 * 4, 2160 * 4);

  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  std::cout << "Goodbye cruel world" << std::endl;
}
