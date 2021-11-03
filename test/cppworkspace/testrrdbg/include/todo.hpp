#pragma once

#include <date.hpp>
#include <string>
#include <string_view>


class Todo {
public:
	Todo(const char* title, Date date);
	std::string_view title() const;
	int id() const;
	static int todo_count();
	const Date& date() const;
private:
	int m_id;
	Date m_date;
	std::string m_title;
	static int s_todo_id;
};
